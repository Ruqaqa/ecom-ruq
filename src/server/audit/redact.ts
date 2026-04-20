/**
 * Redaction for audit payloads.
 *
 * Tier-A plaintext MUST NEVER land in `audit_payloads`, even though rows in
 * that table are PDPL-deletable. A `tier_a.read` audit row records only
 * "which row's Tier-A ciphertext was decrypted" — never the decrypted value.
 *
 * Tier-B fields pass through. That's the point of audit: Tier B is
 * operator-useful state (order totals, cart contents, auth decisions).
 *
 * Per-entity "audit-sensitive field" registries are declared alongside each
 * schema file. Chunk 4 only has one entity with Tier-A content
 * (identity_verifications) and its Tier-A surface is `payload` (bytea) —
 * which nobody would put in an audit payload anyway, so the registry for
 * that entity is an explicit safety net.
 */
const REDACTED = "[REDACTED_TIER_A]";

export type AuditSensitiveRegistry = Record<string, ReadonlyArray<string>>;

export const DEFAULT_REGISTRY: AuditSensitiveRegistry = Object.freeze({
  identity_verifications: Object.freeze(["payload"]),
});

export function redactForAudit<T>(
  obj: T,
  entity: string,
  registry: AuditSensitiveRegistry = DEFAULT_REGISTRY,
): T {
  const sensitive = registry[entity];
  if (!sensitive || sensitive.length === 0) return obj;
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactForAudit(item, entity, registry)) as unknown as T;
  }
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const key of sensitive) {
    if (key in out) out[key] = REDACTED;
  }
  return out as T;
}
