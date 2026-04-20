/**
 * Audit chain helpers — computed at the application layer so HASH_PEPPER
 * never has to live inside the Postgres process.
 *
 * The hash chain pattern (full flow implemented by the chunk 6 audit middleware):
 *   1. Open tx; SET LOCAL app.tenant_id.
 *   2. SELECT pg_advisory_xact_lock(hashtext('audit_log:' || tenant_id)).
 *      This serializes writers within the same tenant; different tenants
 *      don't contend.
 *   3. SELECT row_hash FROM audit_log WHERE tenant_id = $ctx ORDER BY
 *      created_at DESC, id DESC LIMIT 1 — this is the expected prev_log_hash
 *      for the new row.
 *   4. Compute row_hash = HMAC-SHA-256(HASH_PEPPER, canonical_json({
 *        metadata fields + content hashes + prev_log_hash
 *      })).
 *   5. INSERT audit_log with prev_log_hash + row_hash explicit. The trigger
 *      in migrations/0003_audit_triggers.sql re-reads the previous row_hash
 *      under the same advisory lock and compares — if app and trigger
 *      disagree, the insert fails (tamper detection at the DB boundary).
 *
 * Canonicalization: RFC 8785 JCS via src/lib/canonical-json.ts.
 */
import { createHmac } from "node:crypto";
import { canonicalJson } from "@/lib/canonical-json";

const KNOWN_DEV_PATTERNS = [/^change[-_]?me$/i, /^placeholder$/i, /^dev$/i, /^test$/i];
const PEPPER_MIN_BYTES = 32;

let cachedPepper: Buffer | null = null;

/** Module-init-time boot check. Call at app startup to fail loud on misconfig. */
export function assertHashPepperReady(): void {
  loadHashPepper();
}

export function loadHashPepper(): Buffer {
  if (cachedPepper) return cachedPepper;
  const raw = process.env.HASH_PEPPER;
  if (!raw) throw new Error("HASH_PEPPER is not set");
  if (KNOWN_DEV_PATTERNS.some((re) => re.test(raw))) {
    throw new Error("HASH_PEPPER appears to be a placeholder value");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    throw new Error("HASH_PEPPER is not valid base64");
  }
  if (decoded.length < PEPPER_MIN_BYTES) {
    throw new Error(`HASH_PEPPER must decode to at least ${PEPPER_MIN_BYTES} bytes, got ${decoded.length}`);
  }
  if (decoded.every((b) => b === 0)) {
    throw new Error("HASH_PEPPER is all zeros");
  }
  cachedPepper = decoded;
  return decoded;
}

export interface AuditChainRow {
  tenantId: string | null;
  correlationId: string;
  operation: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  actorType: string;
  actorId: string | null;
  tokenId: string | null;
  inputHash: Buffer | null;
  beforeHash: Buffer | null;
  afterHash: Buffer | null;
  createdAt: string;
  error: string | null;
}

/**
 * Peppered HMAC-SHA-256 of a redacted+canonicalized payload. Used for
 * `input_hash`, `before_hash`, `after_hash`. The caller MUST pass the
 * post-redactForAudit value to avoid leaking Tier-A plaintext into the
 * hash domain.
 */
export function hashPayload(payload: unknown, pepper: Buffer = loadHashPepper()): Buffer {
  const bytes = Buffer.from(canonicalJson(payload), "utf8");
  return createHmac("sha256", pepper).update(bytes).digest();
}

/**
 * Peppered HMAC-SHA-256 over the canonical form of {row + prev_log_hash}.
 * Produces the `row_hash` written to audit_log. The DB trigger verifies
 * that prev_log_hash matches the actual prior row under a per-tenant
 * advisory lock; any mismatch rejects the insert.
 *
 * `prevLogHash` is the raw bytes read from the prior row's `row_hash`
 * column (or null if this is the first row for the tenant).
 */
export function computeRowHash(
  row: AuditChainRow,
  prevLogHash: Buffer | null,
  pepper: Buffer = loadHashPepper(),
): Buffer {
  const canonical = canonicalJson({
    tenantId: row.tenantId,
    correlationId: row.correlationId,
    operation: row.operation,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    outcome: row.outcome,
    actorType: row.actorType,
    actorId: row.actorId,
    tokenId: row.tokenId,
    prevLogHash: prevLogHash ? prevLogHash.toString("base64") : null,
    inputHash: row.inputHash ? row.inputHash.toString("base64") : null,
    beforeHash: row.beforeHash ? row.beforeHash.toString("base64") : null,
    afterHash: row.afterHash ? row.afterHash.toString("base64") : null,
    createdAt: row.createdAt,
    error: row.error,
  });
  return createHmac("sha256", pepper).update(Buffer.from(canonical, "utf8")).digest();
}
