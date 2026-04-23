/**
 * Minimal Sentry shim.
 *
 * Sentry initialization is deferred to Phase 1b's Launch infrastructure
 * block (see prd.md — account + DSN not needed for local Phase 0 work).
 * Call sites already exist — chiefly the audit-wrap failure path, which
 * logs `audit_write_failure` when a best-effort failure audit cannot
 * itself be persisted. Rather than sprinkle TODOs, we route through this
 * shim now and swap the body for the real `@sentry/node` client in one
 * edit later.
 *
 * Unit tests inject a spy via `__setSentryForTests` — never via module
 * mocking — so the public API matches what the real client will offer.
 *
 * Chunk 9 (observability prep): every call to `captureMessage` funnels
 * through `scrubObsOptions` before dispatch. Customer and tenant
 * identifier keys (tenant_id, user_id, actor_id, token_id, host, email,
 * plaintext, tokenHash, etc.) are DROPPED from `tags` and `extra` so that
 * neither the console fallback nor the eventual Sentry sink ever sees
 * them. Dropping (rather than redacting with a sentinel) is deliberate:
 * the audit log is the forensic source of truth, and observability
 * payloads are debugging metadata that don't need to preserve shape.
 *
 * The BELT_AND_BRACES_PII_KEYS list from `@/server/audit/redact` is
 * re-used here so one addition to that list (e.g., a new credential
 * field in Phase 2) propagates to both the audit and observability
 * layers without a second registry to keep in sync.
 */
import { BELT_AND_BRACES_PII_KEYS } from "@/server/audit/redact";

export interface SentryLike {
  captureMessage(
    name: string,
    options?: {
      level?: "error" | "warning" | "info";
      tags?: Record<string, string | undefined>;
      extra?: Record<string, unknown>;
    },
  ): void;
}

export type CaptureOptions = NonNullable<Parameters<SentryLike["captureMessage"]>[1]>;

/**
 * Identifier-typed keys that must NEVER reach the observability sink.
 * These are distinct from `BELT_AND_BRACES_PII_KEYS` (the audit-layer
 * PII denylist) because observability call sites use identifier names
 * like `actor_id` or `tenant_id` that don't appear in audit payloads.
 *
 * Matching is case-insensitive against the key name — value shape does
 * not matter (UUID, slug, email-looking-string all drop the same way).
 */
export const OBS_IDENTIFIER_KEYS: readonly string[] = Object.freeze([
  // Tenant
  "tenantId",
  "tenant_id",
  // Actor / user
  "actorId",
  "actor_id",
  "userId",
  "user_id",
  "membershipId",
  "membership_id",
  "sessionId",
  "session_id",
  // Token
  "tokenId",
  "token_id",
  "tokenPrefix",
  "token_prefix",
  // Host (identifies a tenant)
  "host",
  "hostname",
]);

const OBS_SCRUB_KEY_SET: ReadonlySet<string> = new Set(
  [...BELT_AND_BRACES_PII_KEYS, ...OBS_IDENTIFIER_KEYS].map((k) => k.toLowerCase()),
);

// Deeply-pathological structures (circular refs, 10k-deep nesting) must not
// blow the stack on a log call. 20 is well past any realistic extras shape.
const MAX_SCRUB_DEPTH = 20;

/**
 * Recursively drop identifier-typed keys from `value`. Plain objects and
 * arrays are walked. Non-plain objects (class instances like URL, Error
 * subclasses with enumerable fields, etc.) are NEUTRALIZED to a
 * constructor-name sentinel rather than preserved — preserving them
 * would let `JSON.stringify` in the console fallback invoke their
 * `toJSON` methods (URL, Date, etc.) and leak identifier-adjacent data
 * (Host on URL, ISO timestamps on Date, etc.). Buffer and Date still
 * need a textual form in extras for debugging; the sentinel replaces
 * them with `"[object URL]"`/`"[object Date]"` which is safe.
 *
 * Plain objects have any own `toJSON` method stripped during the walk,
 * closing the bypass where a call site attaches a custom `toJSON` that
 * ignores our key-based scrubbing and emits arbitrary strings at
 * stringify time.
 */
export function scrubObsValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_SCRUB_DEPTH) return "[scrub_depth_limit]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubObsValue(item, depth + 1));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    // Class instance — defeat toJSON-based leaks (URL, Date, Error
    // subclasses, etc.) by replacing with a constructor-name sentinel.
    const ctorName = (proto as { constructor?: { name?: string } }).constructor?.name ?? "object";
    return `[object ${ctorName}]`;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (OBS_SCRUB_KEY_SET.has(key.toLowerCase())) continue;
    // Strip any own `toJSON` method from plain objects: if a caller (or
    // upstream helper) attached one, `JSON.stringify` would invoke it at
    // the console-fallback layer and emit whatever string it returns,
    // sidestepping our key-based scrub entirely.
    if (key === "toJSON" && typeof val === "function") continue;
    out[key] = scrubObsValue(val, depth + 1);
  }
  return out;
}

/**
 * Taming helper for error-typed values passed as `extra.cause`.
 *
 * Libraries like `postgres`, Drizzle, and Zod stringify their errors
 * with parameter values inline ("params: <uuid>, <uuid>, ..."), which
 * bypasses the key-based scrubber because it's a single string value.
 * Callers should pass `cause: summarizeErrorForObs(err)` rather than
 * `cause: String(err)` so the log records a usable error shape without
 * quoting identifier values back at us.
 *
 * The output is deliberately cheap — first line of the message, hard-
 * capped to 80 chars. It is enough to know what class of error fired
 * ("Error: Failed query: insert into...") without carrying the tail.
 */
export function summarizeErrorForObs(err: unknown): string {
  if (err instanceof Error) {
    const firstLine = (err.message ?? "").split("\n")[0] ?? "";
    return `${err.name}: ${firstLine.slice(0, 80)}`;
  }
  return String(err).split("\n")[0]!.slice(0, 80);
}

function scrubObsOptions(options: CaptureOptions): CaptureOptions {
  // Build the returned object conditionally so that an absent tags/extra
  // stays absent (exactOptionalPropertyTypes treats optional and undefined
  // as distinct).
  const out: CaptureOptions = { ...options };
  if (options.tags) {
    out.tags = scrubObsValue(options.tags) as NonNullable<CaptureOptions["tags"]>;
  }
  if (options.extra) {
    out.extra = scrubObsValue(options.extra) as NonNullable<CaptureOptions["extra"]>;
  }
  return out;
}

const consoleSentry: SentryLike = {
  captureMessage(name, options) {
    // Structured single-line log so a future tail/jq pipeline can parse it.
    // Real Sentry will replace this entirely.
    console.error(
      JSON.stringify({
        sentry: name,
        level: options?.level ?? "error",
        tags: options?.tags ?? {},
        extra: options?.extra ?? {},
      }),
    );
  },
};

let override: SentryLike | null = null;

export function captureMessage(...args: Parameters<SentryLike["captureMessage"]>): void {
  const [name, options] = args;
  const scrubbed = options ? scrubObsOptions(options) : undefined;
  (override ?? consoleSentry).captureMessage(name, scrubbed);
}

/** Test-only seam. Pass null to restore the console-backed default. */
export function __setSentryForTests(s: SentryLike | null): void {
  override = s;
}
