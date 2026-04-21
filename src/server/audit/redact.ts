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
const REDACTED_SENSITIVE = "[REDACTED_SENSITIVE]";

export type AuditSensitiveRegistry = Record<string, ReadonlyArray<string>>;

export const DEFAULT_REGISTRY: AuditSensitiveRegistry = Object.freeze({
  identity_verifications: Object.freeze(["payload"]),
});

/**
 * Belt-and-braces safety net (independent of the per-entity registry).
 * Any nested key whose name matches one of these (case-insensitive) is
 * replaced with `[REDACTED_SENSITIVE]` before the payload is hashed into
 * the audit chain. Closes the registry-blind PDPL regression where a
 * caller used entity='default' and got zero redaction on a body like
 * `{ password, token, nationalId }`. Matching is case-insensitive.
 */
export const BELT_AND_BRACES_PII_KEYS: readonly string[] = Object.freeze([
  // Credentials
  "password",
  "passwordHash",
  "password_hash",
  "token",
  "tokens",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "secret",
  "apiKey",
  "api_key",
  "authorization",
  "bearer",
  "authToken",
  "auth_token",
  // Financial
  "cardNumber",
  "card_number",
  "pan",
  "cvv",
  "cvc",
  "cvv2",
  "iban",
  "accountNumber",
  "account_number",
  // Identity & contact (belt-and-braces for Phase 1a customer services).
  // email/phone are Tier-B not Tier-A per prd.md §6.5 — including them
  // here errs generous: a false positive (redacting a benign token-ref)
  // is cheaper than a false negative (leaking a real email into the
  // un-scrubbable chain because a service author forgot the entity tag).
  "email",
  "emailAddress",
  "email_address",
  "phone",
  "phoneNumber",
  "phone_number",
  "mobile",
  "ssn",
  "nationalId",
  "national_id",
  "nafath",
]);

const PII_KEY_SET: ReadonlySet<string> = new Set(
  BELT_AND_BRACES_PII_KEYS.map((k) => k.toLowerCase()),
);

/**
 * Walk `obj` and redact PII keys. Returns the input identity unchanged when
 * nothing needed redaction so callers relying on reference equality (e.g.
 * `expect(redactForAudit(obj, 'products')).toBe(obj)`) keep working. This
 * makes the safety net a zero-cost pass for payloads without sensitive
 * keys — the common case.
 */
function redactPiiKeys<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    let changed = false;
    const arrOut: unknown[] = obj.map((item) => {
      const red = redactPiiKeys(item);
      if (red !== item) changed = true;
      return red;
    });
    return (changed ? (arrOut as unknown as T) : obj) as T;
  }
  // Skip non-plain objects (Buffer, Date, etc.) — we don't walk into their
  // internals. The per-entity pass above handles Buffer at the registry
  // level (identity_verifications.payload) and everything else is treated
  // as a scalar here.
  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) return obj;

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (PII_KEY_SET.has(key.toLowerCase())) {
      out[key] = REDACTED_SENSITIVE;
      changed = true;
    } else {
      const red = redactPiiKeys(value);
      out[key] = red;
      if (red !== value) changed = true;
    }
  }
  return (changed ? (out as T) : obj) as T;
}

export function redactForAudit<T>(
  obj: T,
  entity: string,
  registry: AuditSensitiveRegistry = DEFAULT_REGISTRY,
): T {
  // Pass 1: per-entity Tier-A registry (existing behavior).
  let result: T = obj;
  const sensitive = registry[entity];
  if (sensitive && sensitive.length > 0) {
    if (obj === null || typeof obj !== "object") {
      result = obj;
    } else if (Array.isArray(obj)) {
      result = obj.map((item) => redactForAudit(item, entity, registry)) as unknown as T;
    } else {
      const copy: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
      for (const key of sensitive) {
        if (key in copy) copy[key] = REDACTED;
      }
      result = copy as T;
    }
  }
  // Pass 2: belt-and-braces PII-key safety net, recursive, entity-agnostic.
  return redactPiiKeys(result);
}
