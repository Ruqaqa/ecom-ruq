/**
 * Transport-neutral audit helpers — sub-chunk 7.2 Part A.
 *
 * These primitives are shared between:
 *   - tRPC's `src/server/trpc/middleware/audit-wrap.ts` (already live)
 *   - MCP's `src/server/mcp/audit-adapter.ts` (Block 7 Part B)
 *
 * The fuller refactor — extracting a unified `runWithAudit<T>()` that
 * both transports delegate to — was in scope but has been descoped to
 * 7.3 per the plan's fallback ("if the refactor grows past ~10 files or
 * the golden fixture proves brittle, revert tRPC's audit-wrap.ts and
 * duplicate the logic in MCP's adapter. Accept the duplication until
 * 7.3."). In 7.2 the audit shape for MCP is driven entirely by the
 * `ping` tool which registers with `auditMode:"none"`, so no MCP
 * mutation-mode audit path is exercised yet.
 *
 * What we DO extract:
 *   - `mapErrorToAuditCode(err)`: pure fn, transport-agnostic. Both
 *     adapters call it identically on their failure path.
 *   - `inputForFailure(err)`: same — Zod issue extraction is not
 *     transport-specific.
 *
 * The tRPC middleware continues to own its tRPC-specific orchestration
 * (withTenant + `getRawInput` + tRPC `next()` shape). MCP's audit
 * adapter owns its own orchestration. Both import these primitives,
 * avoiding the duplicated-switch drift risk.
 */
import { TRPCError } from "@trpc/server";
import type { AuditErrorCode } from "./error-codes";

/**
 * 3-level `.cause` peel to find a pg SQLSTATE buried under TRPCError / a
 * Drizzle wrapper. Same semantics as the tRPC audit-wrap's extractor.
 */
function extractPgCode(x: unknown): string | undefined {
  const SQLSTATE = /^[A-Z0-9]{5}$/;
  let cur: unknown = x;
  for (let depth = 0; depth < 4 && cur != null; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && SQLSTATE.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Closed-set error → AuditErrorCode. Mirrors the tRPC audit-wrap's
 * mapper; keeping them byte-equivalent is the property both call sites
 * must preserve (see docs/adr/0001 or future 7.3 ADR).
 *
 * TRPCError kinds:
 *   BAD_REQUEST        → validation_failed
 *   NOT_FOUND          → not_found
 *   UNAUTHORIZED /
 *     FORBIDDEN        → forbidden
 *   TOO_MANY_REQUESTS  → rate_limited
 * pg SQLSTATEs:
 *   23505 / 23503      → conflict
 *   42501              → rls_denied
 *   40001              → serialization_failure
 * anything else        → internal_error
 *
 * No fallthrough to err.message — see prd.md §3.7.
 */
export function mapErrorToAuditCode(err: unknown): AuditErrorCode {
  if (err instanceof TRPCError) {
    switch (err.code) {
      case "BAD_REQUEST":
        return "validation_failed";
      case "NOT_FOUND":
        return "not_found";
      case "UNAUTHORIZED":
      case "FORBIDDEN":
        return "forbidden";
      case "TOO_MANY_REQUESTS":
        return "rate_limited";
    }
  }
  const pgCode = extractPgCode(err);
  if (pgCode === "23505" || pgCode === "23503") return "conflict";
  if (pgCode === "42501") return "rls_denied";
  if (pgCode === "40001") return "serialization_failure";
  return "internal_error";
}

interface ZodLike {
  issues?: Array<{ path?: readonly (string | number)[] }>;
}

/**
 * For the failure audit row, write the minimum forensic signal — never
 * raw caller-supplied values.
 *   - Zod/validation failure: `{ kind:'validation', failedPaths:[...] }`.
 *   - anything else: `undefined` (no `input` column).
 */
export function inputForFailure(err: unknown): unknown {
  const zodLike = (err instanceof TRPCError && err.cause !== undefined ? err.cause : err) as ZodLike;
  const issues = zodLike.issues;
  if (Array.isArray(issues)) {
    return {
      kind: "validation",
      failedPaths: issues
        .map((i) => (i.path ?? []).map(String).join("."))
        .filter((s) => s.length > 0),
    };
  }
  return undefined;
}
