/**
 * Audit-log `error` column is populated from a closed set of codes, never
 * from raw error messages. Zod / pg error strings can embed PII (emails,
 * row values), and `audit_log` is append-only + PDPL-un-deletable, so a
 * leaked PII string cannot be scrubbed after the fact.
 *
 * Lives in its own file so chunk 7's MCP adapter can import the type
 * without dragging in the whole `write.ts` transport (which pulls in pg /
 * tx machinery that a type-only consumer does not need).
 */
export type AuditErrorCode =
  | "validation_failed"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "stale_write"
  | "restore_expired"
  | "rls_denied"
  | "rate_limited"
  | "serialization_failure"
  | "internal_error";

/**
 * Thrown by services when an optimistic-concurrency check fails: the
 * row exists, but its `updated_at` advanced past the caller's
 * `expectedUpdatedAt`. The audit mapper recognizes this class and
 * stamps `error: { code: "stale_write" }` so operator dashboards can
 * separate genuine slug-collision conflicts from raced writes.
 *
 * Carries no PII — name, message, and the optional context fields are
 * safe-by-construction (set only by service code, never by user input).
 */
export class StaleWriteError extends Error {
  public readonly stale = true as const;
  constructor(message: string = "stale_write") {
    super(message);
    this.name = "StaleWriteError";
  }
}

/**
 * Thrown by services when a slug uniqueness violation surfaces from
 * pg 23505 on `products_tenant_slug_unique`. Mirrors `StaleWriteError`
 * shape: domain-typed, no PII, audit-mapper recognizes via instanceof
 * (and via TRPCError `.cause` after transport translation) → audit
 * code 'conflict'. Wire message stays the closed-set string
 * 'slug_taken'; the offending slug value is NEVER interpolated.
 */
export class SlugTakenError extends Error {
  public readonly slugTaken = true as const;
  constructor(cause?: unknown) {
    super("slug_taken");
    this.name = "SlugTakenError";
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * Thrown by `restoreProduct` when the caller asks to un-soft-delete a row
 * whose `deleted_at` is older than the 30-day recovery window. Distinct
 * from `not_found` (the row is there) and from `conflict` (no concurrent
 * write — the precondition is the elapsed window). The audit mapper
 * recognizes this class (and its TRPCError `.cause` after transport
 * translation) → audit code 'restore_expired'.
 */
export class RestoreWindowExpiredError extends Error {
  public readonly restoreExpired = true as const;
  constructor(message: string = "restore_expired") {
    super(message);
    this.name = "RestoreWindowExpiredError";
  }
}
