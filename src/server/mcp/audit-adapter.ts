/**
 * MCP audit adapter — sub-chunk 7.2 Part B, refactored in 7.3 to
 * delegate orchestration to the shared `runWithAudit` core.
 *
 * `dispatchTool(ctx, tool, rawInput, config)` is the sole orchestrator
 * that tool handlers flow through. It is responsible for:
 *   1. authorize() — throws McpError on unauthorized/forbidden.
 *   2. Zod parse of input (`.strict()` — extra keys reject).
 *   3. For mutation-mode tools: delegate to `runWithAudit` which opens
 *      withTenant + writes the success audit row in-tx + writes a
 *      best-effort failure audit row on throw + Sentry-captures if the
 *      audit write itself fails. `runWithAudit` passes the opened `tx`
 *      back to the handler so services can insert through it without
 *      re-entering `withTenant` (which is flat-only).
 *      For auditMode:"none" tools: invoke handler with `tx = null` and
 *      skip withTenant entirely.
 *   4. Zod parse of output (Tier-B shape lock via the tool's
 *      `outputSchema.parse`).
 *   5. last_used_at debounce bump (every tool, not just mutations).
 *
 * Operation naming: audit rows for MCP dispatches use `mcp.<tool-name>`
 * (e.g. `mcp.ping`, `mcp.create_product`). Distinct from tRPC's which
 * use the tRPC path ("products.create"). This divergence is deliberate
 * — consumers of the audit log can filter by prefix to split transports.
 *
 * Errors crossing the MCP wire: raw `err.message` is NEVER returned.
 * McpError is the only surface; closed-set `kind` maps to JSON-RPC
 * code via the exhaustive switch in `errors.ts` (F-8 canary).
 */
import type { McpRequestContext } from "./context";
import type { McpTool } from "./tools/registry";
import { mapErrorToAuditCode, inputForFailure } from "@/server/audit/adapter-wrap";
import { appDb, withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { runWithAudit } from "@/server/audit/run-with-audit";
import { writeAuditInOwnTx } from "@/server/audit/write";
import { bumpLastUsedAt, shouldWriteLastUsedAt } from "@/server/auth/last-used-debounce";
import { McpError, auditErrorCodeToMcpKind } from "./errors";
import { isRichCreateDryRunRollback } from "./tools/create-product-rich";
import { DryRunRollback } from "@/server/services/products/create-product-rich";

/**
 * Decision 1 (7.4): `forbidden` refusals are always audited, regardless
 * of `auditMode`. A tool registered with `auditMode:"none"` (a read,
 * per prd §3.7) that refuses with `forbidden` is a security-relevant
 * event on par with a blocked mutation, so it DOES land in
 * `audit_log`. Non-forbidden failures on reads continue to skip audit.
 */
function shouldAuditForbiddenRefusal(
  auditMode: ToolAuditConfig["auditMode"],
  err: unknown,
): boolean {
  if (auditMode === "mutation") return true; // pre-existing behavior
  return err instanceof McpError && err.kind === "forbidden";
}

export interface ToolAuditConfig {
  auditMode: "mutation" | "none";
}

function actorTuple(ctx: McpRequestContext): {
  actorType: "user" | "anonymous";
  actorId: string | null;
  tokenId: string | null;
} {
  if (ctx.identity.type !== "bearer") {
    // Unreachable under the normal route (anonymous rejected at the
    // edge). Kept for defense-in-depth if a future dispatcher invokes
    // a tool outside the HTTP path.
    return { actorType: "anonymous", actorId: null, tokenId: null };
  }
  return {
    actorType: "user",
    actorId: ctx.identity.userId,
    tokenId: ctx.identity.tokenId,
  };
}

function operationName(tool: McpTool<unknown, unknown>): string {
  return `mcp.${tool.name}`;
}

/**
 * Translate any caught error into an McpError so the MCP SDK emits the
 * correct JSON-RPC code on the wire. The SDK reads `err['code']` and
 * `err['message']` directly from the thrown value (see
 * `shared/protocol.js` line ~394). An un-translated raw Error has no
 * numeric `.code`, so the SDK falls back to InternalError (-32603).
 *
 * Preserves McpError as-is; maps everything else via the closed-set
 * `AuditErrorCode` path. The `safeMessage` never echoes raw
 * `err.message` (which could embed PII or a PAT via a developer's
 * stray template string). The original error is retained as `.cause`
 * for Sentry / internal logs only — `McpError` never surfaces cause
 * on the wire because the SDK only reads `message` + `code`.
 */
function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  const auditCode = mapErrorToAuditCode(err);
  const kind = auditErrorCodeToMcpKind(auditCode);
  return new McpError(kind, kind, err);
}

export async function dispatchTool<TIn, TOut>(
  ctx: McpRequestContext,
  tool: McpTool<TIn, TOut>,
  rawInput: unknown,
  config: ToolAuditConfig,
): Promise<TOut> {
  const actor = actorTuple(ctx);
  const operation = operationName(tool as McpTool<unknown, unknown>);

  // Authorize + input parse live OUTSIDE runWithAudit — both failure
  // modes (forbidden, validation_failed) should write audit rows
  // WITHOUT opening a tenant-scoped tx. For mutation-mode tools we
  // audit ALL failures here. For non-mutation tools we audit ONLY
  // `forbidden` refusals (Decision 1, 7.4): refusals are a
  // security-relevant event even on reads. Other read failures
  // (validation, internal) still skip audit per prd §3.7.
  let parsedInput: TIn;
  try {
    tool.authorize(ctx);
    parsedInput = tool.inputSchema.parse(rawInput);
  } catch (err) {
    if (shouldAuditForbiddenRefusal(config.auditMode, err)) {
      // `mapErrorToAuditCode` has no McpError case (it predates this
      // transport and falls back to `internal_error` for unknown
      // shapes). For McpError refusals we already know the closed-set
      // kind; use it directly so a `forbidden` throw audits as
      // `forbidden`, not `internal_error`.
      const errorCode =
        err instanceof McpError && err.kind === "forbidden"
          ? ("forbidden" as const)
          : mapErrorToAuditCode(err);
      await writeAuditInOwnTx({
        tenantId: ctx.tenant.id,
        operation,
        actorType: actor.actorType,
        actorId: actor.actorId,
        tokenId: actor.tokenId,
        outcome: "failure",
        correlationId: ctx.correlationId,
        input: inputForFailure(err),
        errorCode,
      });
    }
    throw toMcpError(err);
  }

  let result: TOut;
  try {
    if (config.auditMode === "mutation" && appDb) {
      // Unreachable under the HTTP route's anonymous-reject at
      // route.ts; explicit throw so a future refactor fails loud,
      // not silent. A mutation-mode dispatch with a non-bearer
      // identity would otherwise silently coerce to role:"anonymous"
      // and feed that through the audit row (O-8, 7.6.6).
      if (ctx.identity.type !== "bearer") {
        throw new McpError(
          "internal_error",
          "mutation-mode dispatch with non-bearer identity",
        );
      }
      const authedCtx = buildAuthedTenantContext(
        { id: ctx.tenant.id },
        {
          userId: actor.actorId,
          actorType: actor.actorType,
          tokenId: actor.tokenId,
          role: ctx.identity.role,
        },
      );
      try {
        result = await runWithAudit<TOut>({
          db: appDb,
          authedCtx,
          tenantId: ctx.tenant.id,
          operation,
          actor,
          correlationId: ctx.correlationId,
          successInput: parsedInput,
          onFailure: (err) => ({
            errorCode: mapErrorToAuditCode(err),
            failureInput: inputForFailure(err),
          }),
          // The rich-create dry-run path throws a sentinel from inside
          // the tx so the tx rolls back — this flag tells runWithAudit
          // to suppress the misleading failure-audit row. The catch
          // below writes a bespoke `.dry_run` success row in its own
          // tx and returns the cached preview to the wire.
          isExpectedRollback: isRichCreateDryRunRollback,
          work: async (tx) => {
            const handlerResult = await tool.handler(ctx, parsedInput, tx);
            const parsedOutput = tool.outputSchema.parse(handlerResult);
            // Tool may have populated ctx.auditOverride to record a
            // different audit shape than the wire return — see
            // McpAuditOverride.
            const after =
              ctx.auditOverride.after !== undefined
                ? ctx.auditOverride.after
                : parsedOutput;
            return {
              result: parsedOutput,
              after,
              ...(ctx.auditOverride.before !== undefined
                ? { before: ctx.auditOverride.before }
                : {}),
            };
          },
        });
      } catch (err) {
        if (err instanceof DryRunRollback) {
          // Architect's spec: write `<operation>.dry_run` success row in
          // its own follow-up tx after rollback. Wire-side, this is a
          // success — return the preview (which already carries the
          // server-minted UUIDs assembled inside the rolled-back tx).
          // See module docstring for the failure-mode race.
          const dryRunOperation = `${operation}.dry_run`;
          await writeAuditInOwnTx({
            tenantId: ctx.tenant.id,
            operation: dryRunOperation,
            actorType: actor.actorType,
            actorId: actor.actorId,
            tokenId: actor.tokenId,
            outcome: "success",
            correlationId: ctx.correlationId,
            input: parsedInput,
            after: err.preview.auditAfter,
          });
          result = err.preview as unknown as TOut;
        } else {
          throw err;
        }
      }
    } else {
      const handlerResult = await tool.handler(ctx, parsedInput, null);
      result = tool.outputSchema.parse(handlerResult);
    }
  } catch (err) {
    // Translate raw errors to McpError so the SDK emits the correct
    // JSON-RPC code on the wire (see `toMcpError` docstring).
    throw toMcpError(err);
  }

  // last_used_at debounce — every tool dispatch, success path only.
  // The UPDATE runs inside a `withTenant` scope so `app.tenant_id` is
  // set for RLS (under `app_user`, without the GUC the UPDATE filters
  // to zero rows — 7.6.1 Block D). Errors are swallowed here to
  // preserve the fail-open posture: debounce never gates.
  if (ctx.identity.type === "bearer" && appDb) {
    const tokenId = ctx.identity.tokenId;
    try {
      const should = await shouldWriteLastUsedAt(tokenId);
      if (should) {
        const bumpCtx = buildAuthedTenantContext(
          { id: ctx.tenant.id },
          {
            userId: actor.actorId,
            actorType: actor.actorType,
            tokenId: actor.tokenId,
            role: ctx.identity.role,
          },
        );
        await withTenant(appDb, bumpCtx, async (tx) =>
          bumpLastUsedAt(tx, tokenId, ctx.tenant.id),
        );
      }
    } catch (err) {
      // fail-open — debounce never gates.
      const { captureMessage, summarizeErrorForObs } = await import("@/server/obs/sentry");
      captureMessage("last_used_bump_failure", {
        level: "warning",
        tags: {
          tenant_id: ctx.tenant.id,
          token_id: tokenId,
        },
        extra: { cause: summarizeErrorForObs(err) },
      });
    }
  }

  return result;
}
