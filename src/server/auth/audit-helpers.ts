// TEMPORARY — delete when chunk 6 ships audit adapter
/**
 * Narrow audit helper for auth events in chunk 5.
 *
 * Chunk 6 moves audit wrapping to the service-layer adapter (tRPC / MCP).
 * Until then, signup / verify / magic-link-consume / rate-limit-exceeded
 * all happen inside Better Auth's own request path, outside the tRPC
 * context. We still want them recorded so the Phase 0 chain is complete.
 *
 * Approach:
 *   - Open a SHORT transaction with `withTenant` (the caller passes the
 *     tenant context obtained from the resolver).
 *   - Acquire the per-tenant advisory lock.
 *   - Read the current chain head.
 *   - Compute row_hash at the app layer.
 *   - Insert audit_log + optional audit_payloads in the same tx.
 *
 * The BEFORE INSERT trigger on audit_log validates our prev_log_hash. If
 * two chunk-5 paths race, one will get SQLSTATE 40001 and retry — the
 * helper handles that by retrying once, which is enough because auth
 * traffic is not hot.
 *
 * Tier-A redaction is applied before hashing the payload. Secrets (raw
 * passwords, raw tokens) are never written — only structural facts
 * ("user-id X initiated magic-link" not "magic-link token was VALUE").
 */
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { appDb, withTenant, type Tx } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { auditLog, auditPayloads } from "@/server/db/schema/audit";
import { computeRowHash, hashPayload, type AuditChainRow } from "@/server/audit/chain";
import { redactForAudit } from "@/server/audit/redact";

export type AuthAuditOperation =
  | "auth.signup"
  | "auth.verify-email"
  | "auth.magic-link.request"
  | "auth.magic-link.consume"
  | "auth.session.create"
  | "auth.session.revoke"
  | "auth.rate-limit-exceeded";

export interface AuthAuditInput {
  tenantId: string;
  operation: AuthAuditOperation;
  actorType: "user" | "system" | "anonymous";
  actorId: string | null;
  outcome: "success" | "failure";
  correlationId?: string;
  input?: unknown;
  before?: unknown;
  after?: unknown;
  error?: string | null;
}

async function insertAuditInTx(tx: Tx, row: AuthAuditInput): Promise<void> {
  const entity = "auth";
  const redactedInput = row.input !== undefined ? redactForAudit(row.input, entity) : null;
  const redactedBefore = row.before !== undefined ? redactForAudit(row.before, entity) : null;
  const redactedAfter = row.after !== undefined ? redactForAudit(row.after, entity) : null;

  const inputHash = redactedInput !== null ? hashPayload(redactedInput) : null;
  const beforeHash = redactedBefore !== null ? hashPayload(redactedBefore) : null;
  const afterHash = redactedAfter !== null ? hashPayload(redactedAfter) : null;

  // Per-tenant advisory xact lock — same key shape as the BEFORE INSERT
  // trigger uses. Must be held while we read prev_log_hash and compute
  // row_hash, or the trigger will raise SQLSTATE 40001.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('audit_log:' || ${row.tenantId}))`);

  const prevRows = await tx.execute<{ row_hash: Buffer | null }>(
    sql`SELECT row_hash FROM audit_log WHERE tenant_id = ${row.tenantId}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  const prevArr = Array.isArray(prevRows)
    ? prevRows
    : ((prevRows as { rows?: Array<{ row_hash: Buffer | null }> }).rows ?? []);
  const prevLogHash: Buffer | null = prevArr[0]?.row_hash ?? null;

  const correlationId = row.correlationId ?? randomUUID();
  const createdAt = new Date().toISOString();

  const chainRow: AuditChainRow = {
    tenantId: row.tenantId,
    correlationId,
    operation: row.operation,
    resourceType: null,
    resourceId: null,
    outcome: row.outcome,
    actorType: row.actorType,
    actorId: row.actorId,
    tokenId: null,
    inputHash,
    beforeHash,
    afterHash,
    createdAt,
    error: row.error ?? null,
  };
  const rowHash = computeRowHash(chainRow, prevLogHash);

  await tx.insert(auditLog).values({
    correlationId,
    operation: row.operation,
    outcome: row.outcome,
    actorType: row.actorType,
    actorId: row.actorId,
    tenantId: row.tenantId,
    tokenId: null,
    prevLogHash,
    inputHash,
    beforeHash,
    afterHash,
    rowHash,
    error: row.error ?? null,
    createdAt: new Date(createdAt),
  });

  if (redactedInput !== null) {
    await tx.insert(auditPayloads).values({
      correlationId,
      kind: "input",
      tenantId: row.tenantId,
      payload: redactedInput as never,
    });
  }
  if (redactedBefore !== null) {
    await tx.insert(auditPayloads).values({
      correlationId,
      kind: "before",
      tenantId: row.tenantId,
      payload: redactedBefore as never,
    });
  }
  if (redactedAfter !== null) {
    await tx.insert(auditPayloads).values({
      correlationId,
      kind: "after",
      tenantId: row.tenantId,
      payload: redactedAfter as never,
    });
  }
}

export async function writeAuthAudit(row: AuthAuditInput): Promise<void> {
  if (!appDb) return; // fail soft — chunk 5 is best-effort per design.
  const ctx = buildAuthedTenantContext(
    { id: row.tenantId },
    { userId: null, role: "anonymous" },
  );

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await withTenant(appDb, ctx, async (tx) => insertAuditInTx(tx, row));
      return;
    } catch (err) {
      // Retry once on serialization failure (the BEFORE INSERT trigger
      // raises 40001 if we lost the chain race). The withTenant helper
      // catches and rethrows — match the SQLSTATE in the message.
      lastErr = err;
      if (
        err instanceof Error &&
        /chain race|40001|serialization_failure/i.test(err.message)
      ) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
