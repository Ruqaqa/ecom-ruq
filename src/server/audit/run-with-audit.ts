/**
 * `runWithAudit` — the transport-neutral audit orchestration core.
 * Landed in sub-chunk 7.3 to unify tRPC (`audit-wrap.ts`) and MCP
 * (`audit-adapter.ts`) which previously each owned their own withTenant +
 * insertAuditInTx + writeAuditInOwnTx + Sentry orchestration.
 *
 * Responsibility — orchestration only:
 *   1. Open `withTenant(db, authedCtx, fn)` exactly once.
 *   2. Run caller's `work(tx)` thunk inside the tx.
 *   3. On success, write an `outcome='success'` audit row in the SAME tx
 *      via `insertAuditInTx`. Rolled back atomically if the tx later
 *      throws (which cannot happen from in here — work is the last
 *      thing that can throw inside the tx).
 *   4. On throw, write a best-effort `outcome='failure'` row in its OWN
 *      tx via `writeAuditInOwnTx` with the closed-set `errorCode`
 *      derived from `onFailure(err)`. Re-throw the original error.
 *   5. If `writeAuditInOwnTx` itself throws (e.g. DB down while we try
 *      to record the failure), fire Sentry `audit_write_failure` —
 *      Decision 1 (A) from the sub-chunk 7.3 plan: unified across
 *      transports. Previously tRPC had this belt-and-braces hook, MCP
 *      did not; unifying at this seam gives MCP equivalent
 *      observability for free.
 *
 * What this module does NOT own (per-transport concerns):
 *   - Authorization.
 *   - Input/output Zod parsing.
 *   - Raw-input capture (tRPC's getRawInput; MCP's already-parsed
 *     rawArguments pass-through).
 *   - Actor/session derivation (each transport supplies the shape).
 *   - last_used_at debounce.
 *   - McpError / TRPCError construction on the edges.
 *
 * The `onFailure` closure exists so the caller can keep transport-
 * aware failure-input shaping (tRPC's inputForFailure, MCP's same)
 * without this module importing transport machinery.
 */
import type { AppDb, Tx } from "@/server/db";
import { withTenant } from "@/server/db";
import type { AuthedTenantContext, ActorType } from "@/server/tenant/context";
import { insertAuditInTx, writeAuditInOwnTx } from "./write";
import type { AuditErrorCode } from "./error-codes";
import { canonicalJson } from "@/lib/canonical-json";

export interface RunWithAuditActor {
  actorType: ActorType;
  actorId: string | null;
  tokenId: string | null;
}

export interface RunWithAuditArgs<T> {
  db: AppDb;
  authedCtx: AuthedTenantContext;
  tenantId: string;
  operation: string;
  actor: RunWithAuditActor;
  correlationId: string;
  /**
   * Written to `audit_log` input column on the SUCCESS path only. The
   * caller decides whether this is the raw request body, a parsed
   * projection, or undefined — the shared core does not care.
   */
  successInput: unknown;
  /**
   * Mapper invoked on throw. Returns the closed-set `errorCode` and
   * the `failureInput` to record — typically field-paths only for
   * validation failures (see `src/server/audit/adapter-wrap.ts`
   * `inputForFailure`).
   */
  onFailure(err: unknown): { errorCode: AuditErrorCode; failureInput: unknown };
  /**
   * The caller's unit of work. Runs inside the opened tx. Must return
   * the value the outer caller will receive PLUS the `after` payload
   * the success audit row should record (often the same — the parsed
   * output — but transport-specific so we keep them split). Optionally
   * returns a `before` payload — for write operations whose audit
   * forensic value depends on the pre-update row state (chunk 1a.2's
   * updateProduct, future delete/update flows). Reads / no-op writes
   * leave `before` undefined.
   */
  work(tx: Tx): Promise<{ result: T; after: unknown; before?: unknown }>;
}

function rawInputBytes(v: unknown): number {
  return Buffer.byteLength(canonicalJson(v ?? null), "utf8");
}

export async function runWithAudit<T>(args: RunWithAuditArgs<T>): Promise<T> {
  try {
    return await withTenant(args.db, args.authedCtx, async (tx) => {
      const { result, after, before } = await args.work(tx);
      await insertAuditInTx(tx, {
        tenantId: args.tenantId,
        operation: args.operation,
        actorType: args.actor.actorType,
        actorId: args.actor.actorId,
        tokenId: args.actor.tokenId,
        outcome: "success",
        correlationId: args.correlationId,
        input: args.successInput,
        ...(before !== undefined ? { before } : {}),
        after,
      });
      return result;
    });
  } catch (err) {
    const { errorCode, failureInput } = args.onFailure(err);
    await writeAuditInOwnTx({
      tenantId: args.tenantId,
      operation: args.operation,
      actorType: args.actor.actorType,
      actorId: args.actor.actorId,
      tokenId: args.actor.tokenId,
      outcome: "failure",
      correlationId: args.correlationId,
      input: failureInput,
      errorCode,
    }).catch(async (auditErr) => {
      // writeAuditInOwnTx already captures via Sentry on its own throw,
      // but surfacing here too is a belt-and-braces guard so both
      // transports see equivalent observability if the inner shim
      // ever stops swallowing. Decision 1 (A) — unified here.
      const { captureMessage, summarizeErrorForObs } = await import("@/server/obs/sentry");
      captureMessage("audit_write_failure", {
        level: "error",
        tags: {
          correlation_id: args.correlationId,
          tenant_id: args.tenantId,
          operation: args.operation,
          actor_type: args.actor.actorType,
          code: errorCode,
        },
        extra: {
          actor_id: args.actor.actorId,
          token_id: args.actor.tokenId,
          raw_input_bytes: rawInputBytes(args.successInput),
          cause: summarizeErrorForObs(auditErr),
        },
      });
    });
    throw err;
  }
}
