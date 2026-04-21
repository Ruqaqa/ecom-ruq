/**
 * MCP audit adapter — sub-chunk 7.2 Part B.
 *
 * `dispatchTool(ctx, tool, rawInput, config)` is the sole orchestrator
 * that tool handlers flow through. It is responsible for:
 *   1. authorize() — throws McpError on unauthorized/forbidden.
 *   2. Zod parse of input (`.strict()` — extra keys reject).
 *   3. handler(ctx, parsedInput).
 *   4. Zod parse of output (Tier-B shape lock).
 *   5. last_used_at debounce bump (every tool, not just mutations).
 *   6. Audit: if config.auditMode === "mutation", wrap the handler in
 *      `withTenant` + `insertAuditInTx`. Success writes an audit row;
 *      failure writes a best-effort failure audit via
 *      `writeAuditInOwnTx` with a closed-set code — NO `err.message`
 *      ever crosses into the audit row (same invariant as tRPC).
 *   7. Error re-throw: the caller (registry / transport) translates
 *      McpError → JSON-RPC code. Raw `err.message` is NOT returned on
 *      the wire (security watchout B-3 + F-8 canary).
 *
 * Operation naming: audit rows for MCP dispatches use `mcp.<tool-name>`
 * (e.g. `mcp.ping`, `mcp.create_product`). Distinct from tRPC's which
 * use the tRPC path. Consumers of the audit log can filter by prefix
 * to split transports.
 *
 * `ping` registers with `auditMode:"none"` — reads do NOT audit per
 * prd.md §3.7 ("Reads of Tier-B and Tier-C fields are not audit-
 * logged"). Mutations in 7.3+ will flip it to "mutation".
 */
import type { McpRequestContext } from "./context";
import type { McpTool } from "./tools/registry";
import { mapErrorToAuditCode, inputForFailure } from "@/server/audit/adapter-wrap";
import {
  appDb,
  withTenant,
} from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { insertAuditInTx, writeAuditInOwnTx } from "@/server/audit/write";
import { bumpLastUsedAt, shouldWriteLastUsedAt } from "@/server/auth/last-used-debounce";

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

export async function dispatchTool<TIn, TOut>(
  ctx: McpRequestContext,
  tool: McpTool<TIn, TOut>,
  rawInput: unknown,
  config: ToolAuditConfig,
): Promise<TOut> {
  // 1-2. Authorize + parse. Failures on either throw — caught below.
  const actor = actorTuple(ctx);
  const operation = operationName(tool as McpTool<unknown, unknown>);

  try {
    tool.authorize(ctx);
    const parsedInput = tool.inputSchema.parse(rawInput);

    // 3-4. Delegate to the handler + output parse. Two branches based
    // on auditMode — mutation wraps in withTenant + success audit row;
    // none just runs.
    let result: TOut;
    if (config.auditMode === "mutation" && appDb) {
      const authedCtx = buildAuthedTenantContext(
        { id: ctx.tenant.id },
        {
          userId: actor.actorId,
          actorType: actor.actorType,
          tokenId: actor.tokenId,
          role: ctx.identity.type === "bearer" ? ctx.identity.role : "anonymous",
        },
      );
      result = await withTenant(appDb, authedCtx, async (tx) => {
        const handlerResult = await tool.handler(ctx, parsedInput);
        const parsedOutput = tool.outputSchema.parse(handlerResult);
        await insertAuditInTx(tx, {
          tenantId: ctx.tenant.id,
          operation,
          actorType: actor.actorType,
          actorId: actor.actorId,
          tokenId: actor.tokenId,
          outcome: "success",
          correlationId: ctx.correlationId,
          input: parsedInput,
          after: parsedOutput,
        });
        return parsedOutput;
      });
    } else {
      const handlerResult = await tool.handler(ctx, parsedInput);
      result = tool.outputSchema.parse(handlerResult);
    }

    // 5. last_used_at debounce — every tool dispatch, success path only.
    // Swallows errors internally.
    if (ctx.identity.type === "bearer") {
      const tokenId = ctx.identity.tokenId;
      try {
        const should = await shouldWriteLastUsedAt(tokenId);
        if (should) await bumpLastUsedAt(tokenId, ctx.tenant.id);
      } catch {
        // fail-open — debounce never gates.
      }
    }

    return result;
  } catch (err) {
    // 6. Failure path — write a best-effort failure audit row when the
    // tool was mutation-mode. Closed-set code only; never err.message.
    if (config.auditMode === "mutation") {
      const code = mapErrorToAuditCode(err);
      const failureInput = inputForFailure(err);
      await writeAuditInOwnTx({
        tenantId: ctx.tenant.id,
        operation,
        actorType: actor.actorType,
        actorId: actor.actorId,
        tokenId: actor.tokenId,
        outcome: "failure",
        correlationId: ctx.correlationId,
        input: failureInput,
        errorCode: code,
      });
    }
    // 7. Re-throw — registry → transport translates to JSON-RPC.
    throw err;
  }
}
