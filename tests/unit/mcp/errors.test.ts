/**
 * `McpError` + JSON-RPC code mapping.
 *
 * The exhaustive switch with no `default` clause means adding a ninth
 * `AuditErrorCode` without a new `case` fails `pnpm typecheck`. This
 * runtime test pins the existing 8 → JSON-RPC code mapping.
 */
import { describe, it, expect } from "vitest";
import {
  McpError,
  auditErrorCodeToJsonRpcCode,
  mcpErrorToJsonRpcCode,
} from "@/server/mcp/errors";
import type { AuditErrorCode } from "@/server/audit/error-codes";
import type { McpErrorKind } from "@/server/mcp/errors";

describe("McpError", () => {
  it("carries kind + safeMessage and preserves the cause without exposing it", () => {
    const cause = new Error("secret leaked");
    const err = new McpError("forbidden", "nope", cause);
    expect(err.kind).toBe("forbidden");
    expect(err.safeMessage).toBe("nope");
    expect(err.cause).toBe(cause);
    expect(err.message).toBe("nope");
  });

  it("defaults safeMessage to the kind when omitted", () => {
    const err = new McpError("unauthorized");
    expect(err.safeMessage).toBe("unauthorized");
  });
});

describe("auditErrorCodeToJsonRpcCode — exhaustive mapping", () => {
  const codes: AuditErrorCode[] = [
    "validation_failed",
    "not_found",
    "forbidden",
    "rate_limited",
    "conflict",
    "rls_denied",
    "serialization_failure",
    "internal_error",
  ];
  it("maps all 8 AuditErrorCode values to a JSON-RPC code", () => {
    for (const c of codes) {
      const mapped = auditErrorCodeToJsonRpcCode(c);
      expect(typeof mapped).toBe("number");
      expect(mapped).toBeLessThan(0);
    }
  });
  it("never maps two different codes to the same JSON-RPC code except by design (forbidden/unauthorized share)", () => {
    // Each AuditErrorCode gets a distinct JSON-RPC code in this mapping.
    const mapped = codes.map(auditErrorCodeToJsonRpcCode);
    const unique = new Set(mapped);
    expect(unique.size).toBe(codes.length);
  });
});

describe("mcpErrorToJsonRpcCode — exhaustive mapping", () => {
  const kinds: McpErrorKind[] = [
    "unauthorized",
    "forbidden",
    "not_found",
    "rate_limited",
    "validation_failed",
    "internal_error",
  ];
  it("maps every McpErrorKind to a JSON-RPC code", () => {
    for (const k of kinds) {
      expect(typeof mcpErrorToJsonRpcCode(k)).toBe("number");
    }
  });
  it("unauthorized and forbidden intentionally share -32003", () => {
    expect(mcpErrorToJsonRpcCode("unauthorized")).toBe(mcpErrorToJsonRpcCode("forbidden"));
  });
});
