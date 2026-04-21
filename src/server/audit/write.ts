/**
 * Transport-agnostic audit writer.
 *
 * Two exports:
 *   - `insertAuditInTx(tx, row)` — inserts one audit_log row (and optional
 *     audit_payloads rows) inside the caller's tx. Acquires the per-tenant
 *     advisory lock, reads the chain head, computes row_hash at the app
 *     layer. The BEFORE INSERT trigger in migrations/0003 re-reads under
 *     the same advisory lock and rejects a mismatch (tamper detection at
 *     the DB boundary).
 *   - `writeAuditInOwnTx(row)` — opens a `withTenant` tx around
 *     `insertAuditInTx`. Best-effort: swallows thrown tx errors and logs
 *     `audit_write_failure` via the Sentry shim. NO retry loop — the
 *     audit-wrap middleware's caller already has a user-visible error to
 *     return, and a retry loop masks real failures (the chain-race
 *     retry that chunk-5's the auth-audit helper did was only meaningful for
 *     the auth path, which had no user error to surface).
 *
 * The `audit_log.error` column is populated ONLY from a closed-set
 * `AuditErrorCode` (see ./error-codes.ts). Raw `err.message` / stacks /
 * pg error strings never touch this column, because audit_log is
 * append-only and PDPL-un-deletable — a leaked email or row value there
 * cannot be scrubbed later. When `errorCode` is passed the column
 * receives `JSON.stringify({ code })`; otherwise it's null.
 */
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { appDb, withTenant, type Tx } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { auditLog, auditPayloads } from "@/server/db/schema/audit";
import { computeRowHash, hashPayload, type AuditChainRow } from "./chain";
import { redactForAudit } from "./redact";
import type { AuditErrorCode } from "./error-codes";
import { canonicalJson } from "@/lib/canonical-json";

/**
 * 64KB cap on serialized `input`/`before`/`after` payloads BEFORE hashing.
 * The Zod 16KB refine on `LocalizedText` doesn't help on paths where Zod
 * throws before the refine runs, or on paths that don't use LocalizedText.
 * 64KB is 4× the LocalizedText cap — allows realistic nested inputs while
 * bounding the advisory-lock window on hostile bodies.
 */
const MAX_AUDIT_PAYLOAD_BYTES = 64 * 1024;

function capForHash(v: unknown): unknown {
  if (v === undefined) return undefined;
  const bytes = Buffer.byteLength(canonicalJson(v), "utf8");
  if (bytes > MAX_AUDIT_PAYLOAD_BYTES) {
    return { __oversized: true, approx_bytes: bytes };
  }
  return v;
}

export type AuditOutcome = "success" | "failure";
export type { AuditErrorCode };

export interface AuditWriteInput {
  tenantId: string;
  operation: string;
  actorType: "user" | "system" | "anonymous";
  actorId: string | null;
  tokenId: string | null;
  outcome: AuditOutcome;
  correlationId?: string;
  input?: unknown;
  before?: unknown;
  after?: unknown;
  errorCode?: AuditErrorCode;
  /**
   * Redaction registry key. Default `'default'` (no Tier-A fields). Pass
   * `'identity_verifications'` when writing audit for a Nafath event so
   * Tier-A payload fields are replaced with `[REDACTED_TIER_A]` before
   * hashing.
   */
  entity?: string;
}

export async function insertAuditInTx(tx: Tx, row: AuditWriteInput): Promise<void> {
  const entity = row.entity ?? "default";
  // Cap oversize payloads BEFORE redaction + hashing so a multi-MB hostile
  // body doesn't stretch the per-tenant advisory-lock window while we
  // canonicalize and hash. capForHash preserves the payload verbatim
  // under the cap; oversized payloads become a stub marker, never written
  // in raw form.
  const cappedInput = capForHash(row.input);
  const cappedBefore = capForHash(row.before);
  const cappedAfter = capForHash(row.after);
  const redactedInput = cappedInput !== undefined ? redactForAudit(cappedInput, entity) : null;
  const redactedBefore = cappedBefore !== undefined ? redactForAudit(cappedBefore, entity) : null;
  const redactedAfter = cappedAfter !== undefined ? redactForAudit(cappedAfter, entity) : null;

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
  const errorColumn = row.errorCode ? JSON.stringify({ code: row.errorCode }) : null;

  const chainRow: AuditChainRow = {
    tenantId: row.tenantId,
    correlationId,
    operation: row.operation,
    resourceType: null,
    resourceId: null,
    outcome: row.outcome,
    actorType: row.actorType,
    actorId: row.actorId,
    tokenId: row.tokenId,
    inputHash,
    beforeHash,
    afterHash,
    createdAt,
    error: errorColumn,
  };
  const rowHash = computeRowHash(chainRow, prevLogHash);

  await tx.insert(auditLog).values({
    correlationId,
    operation: row.operation,
    outcome: row.outcome,
    actorType: row.actorType,
    actorId: row.actorId,
    tenantId: row.tenantId,
    tokenId: row.tokenId,
    prevLogHash,
    inputHash,
    beforeHash,
    afterHash,
    rowHash,
    error: errorColumn,
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

export async function writeAuditInOwnTx(row: AuditWriteInput): Promise<void> {
  if (!appDb) return; // no DB configured (tests without DATABASE_URL).

  const ctx = buildAuthedTenantContext(
    { id: row.tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );

  try {
    await withTenant(appDb, ctx, async (tx) => insertAuditInTx(tx, row));
  } catch (auditErr) {
    const { captureMessage } = await import("@/server/obs/sentry");
    captureMessage("audit_write_failure", {
      level: "error",
      tags: {
        tenant_id: row.tenantId,
        operation: row.operation,
        actor_type: row.actorType,
        code: row.errorCode,
      },
      extra: {
        actor_id: row.actorId,
        token_id: row.tokenId,
        raw_input_bytes: Buffer.byteLength(canonicalJson(row.input ?? null), "utf8"),
        cause: String(auditErr),
      },
    });
  }
}
