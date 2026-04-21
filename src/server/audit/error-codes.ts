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
  | "rls_denied"
  | "rate_limited"
  | "serialization_failure"
  | "internal_error";
