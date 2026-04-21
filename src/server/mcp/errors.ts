/**
 * Closed-set `McpError` — the ONLY error type we surface from MCP tool
 * handlers / authorize / dispatch. Every public MCP surface translates
 * user-visible messages through this set, never raw `err.message`.
 *
 * Why:
 *   - Security watchout B-3 (7.2 plan): PAT plaintext or other PII can
 *     be embedded in a stray `err.message` (a chained Error, a dev-
 *     forgotten template string). JSON-RPC responses carry `error.message`
 *     on the wire; a raw `err.message` crossing that boundary is an
 *     unfixable leak. The F-8 canary regression-tests the invariant.
 *
 * JSON-RPC code mapping mirrors the adapter-neutral `AuditErrorCode` set:
 *   - McpError.kind = "unauthorized"                            → -32003
 *   - McpError.kind = "forbidden"                               → -32003
 *   - McpError.kind = "not_found"                               → -32004
 *   - McpError.kind = "rate_limited"                            → -32005
 *   - McpError.kind = "validation_failed"                       → -32602
 *   - McpError.kind = "conflict"                                → -32006
 *   - McpError.kind = "rls_denied"                              → -32007
 *   - McpError.kind = "serialization_failure"                   → -32008
 *   - McpError.kind = "internal_error"                          → -32603
 *
 * Separately, the adapter-neutral dispatcher (Block 7 part B) maps any
 * non-McpError throw to { kind: "internal_error", cause: err }. The raw
 * cause is retained for Sentry but the wire body never includes it.
 *
 * The `.code` numeric field exists so the MCP SDK's JSON-RPC response
 * emitter in `shared/protocol.js` transcribes it to the wire body as-is
 * (it reads `error['code']` directly, falling back to InternalError
 * when the thrown object lacks one). Without this, every non-ping
 * handler throw would surface as -32603 on the wire.
 */
import type { AuditErrorCode } from "@/server/audit/error-codes";

export type McpErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "validation_failed"
  | "conflict"
  | "rls_denied"
  | "serialization_failure"
  | "internal_error";

export class McpError extends Error {
  public readonly kind: McpErrorKind;
  public readonly safeMessage: string;
  /**
   * Numeric JSON-RPC code — the MCP SDK's response emitter reads
   * `err['code']` directly when building the wire envelope. Setting it
   * at construction time is what makes the numeric mapping reach the
   * client body (without it, every thrown McpError shows up as
   * InternalError / -32603).
   */
  public readonly code: number;
  public override readonly cause?: unknown;
  constructor(
    kind: McpErrorKind,
    /** Human-readable — safe-by-construction because we mint it, not the caller. */
    safeMessage: string = kind,
    /**
     * Retained for Sentry / internal logs. NEVER passed to the JSON-RPC
     * response body.
     */
    cause?: unknown,
  ) {
    super(safeMessage);
    this.name = "McpError";
    this.kind = kind;
    this.safeMessage = safeMessage;
    this.code = mcpErrorToJsonRpcCode(kind);
    this.cause = cause;
  }
}

/**
 * Exhaustive switch over AuditErrorCode → JSON-RPC error code. No
 * `default` clause: adding a new AuditErrorCode without extending this
 * switch fails TypeScript build (the `never` check below).
 *
 * See sub-chunk 7.2 plan Block 5: "Add a compile-time exhaustiveness
 * canary so adding a ninth AuditErrorCode fails `pnpm typecheck` without
 * needing anyone to touch this file."
 */
/**
 * `AuditErrorCode → McpErrorKind` — one-to-one. Every member of the
 * audit closed set has a matching McpErrorKind so a service-layer
 * throw can be translated into an `McpError` with the right numeric
 * JSON-RPC code on the wire. Same exhaustiveness canary shape as the
 * JSON-RPC mapper below.
 */
export function auditErrorCodeToMcpKind(code: AuditErrorCode): McpErrorKind {
  switch (code) {
    case "validation_failed":     return "validation_failed";
    case "not_found":             return "not_found";
    case "forbidden":             return "forbidden";
    case "rate_limited":          return "rate_limited";
    case "conflict":              return "conflict";
    case "rls_denied":            return "rls_denied";
    case "serialization_failure": return "serialization_failure";
    case "internal_error":        return "internal_error";
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const exhaustive: never = code;
  return "internal_error";
}

export function auditErrorCodeToJsonRpcCode(code: AuditErrorCode): number {
  switch (code) {
    case "validation_failed":     return -32602;
    case "not_found":             return -32004;
    case "forbidden":             return -32003;
    case "rate_limited":          return -32005;
    case "conflict":              return -32006;
    case "rls_denied":            return -32007;
    case "serialization_failure": return -32008;
    case "internal_error":        return -32603;
  }
  // Compile-time exhaustiveness canary. If a ninth AuditErrorCode is
  // added without a new `case`, TypeScript infers `code` as that new
  // code at this point (not `never`) and the assignment below fails
  // build. Deliberately NO default branch — exhaustiveness guarantees
  // full coverage.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const exhaustive: never = code;
  return -32603;
}

export function mcpErrorToJsonRpcCode(kind: McpErrorKind): number {
  switch (kind) {
    case "unauthorized":           return -32003;
    case "forbidden":              return -32003;
    case "not_found":               return -32004;
    case "rate_limited":           return -32005;
    case "validation_failed":      return -32602;
    case "conflict":               return -32006;
    case "rls_denied":             return -32007;
    case "serialization_failure": return -32008;
    case "internal_error":         return -32603;
  }
  // Same exhaustiveness canary shape.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const exhaustive: never = kind;
  return -32603;
}
