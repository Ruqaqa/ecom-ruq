/**
 * `stale_write` audit code — chunk 1a.2 closed-set extension.
 *
 * Covers:
 *   - mapErrorToAuditCode recognizes StaleWriteError directly (MCP path).
 *   - mapErrorToAuditCode recovers stale_write via TRPCError's cause
 *     (tRPC procedures translate StaleWriteError → CONFLICT for the wire,
 *     keeping cause so the audit mapper can still distinguish from
 *     slug-collision conflicts).
 *   - auditErrorCodeToMcpKind covers the new code (compile-time
 *     exhaustiveness; this is a runtime smoke in case someone forgets a
 *     case).
 *   - JSON-RPC code mapping is the new -32009.
 */
import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { mapErrorToAuditCode } from "@/server/audit/adapter-wrap";
import { StaleWriteError } from "@/server/audit/error-codes";
import {
  auditErrorCodeToMcpKind,
  auditErrorCodeToJsonRpcCode,
  mcpErrorToJsonRpcCode,
} from "@/server/mcp/errors";

describe("stale_write audit error code", () => {
  it("maps a bare StaleWriteError to 'stale_write'", () => {
    expect(mapErrorToAuditCode(new StaleWriteError())).toBe("stale_write");
  });

  it("maps a TRPCError with a StaleWriteError cause to 'stale_write' (not 'conflict')", () => {
    const err = new TRPCError({
      code: "CONFLICT",
      message: "stale_write",
      cause: new StaleWriteError(),
    });
    expect(mapErrorToAuditCode(err)).toBe("stale_write");
  });

  it("a CONFLICT TRPCError WITHOUT a StaleWriteError cause still maps to 'conflict'-like internal_error path (slug collisions go through pg 23505 not TRPCError code)", () => {
    // Explicit: a plain TRPCError CONFLICT (no cause) doesn't have a
    // dedicated branch and falls to internal_error. Slug-collision
    // conflicts arrive as a pg DatabaseError with code 23505 (handled
    // by the pgCode branch); TRPCError CONFLICT alone isn't a path
    // our codebase produces for slug collisions today.
    const err = new TRPCError({ code: "CONFLICT", message: "x" });
    expect(mapErrorToAuditCode(err)).toBe("internal_error");
  });

  it("auditErrorCodeToMcpKind('stale_write') === 'stale_write'", () => {
    expect(auditErrorCodeToMcpKind("stale_write")).toBe("stale_write");
  });

  it("auditErrorCodeToJsonRpcCode('stale_write') === -32009", () => {
    expect(auditErrorCodeToJsonRpcCode("stale_write")).toBe(-32009);
  });

  it("mcpErrorToJsonRpcCode('stale_write') === -32009", () => {
    expect(mcpErrorToJsonRpcCode("stale_write")).toBe(-32009);
  });

  it("StaleWriteError carries a `stale: true` discriminator and a safe-by-construction message", () => {
    const err = new StaleWriteError();
    expect(err.stale).toBe(true);
    expect(err.name).toBe("StaleWriteError");
    expect(err.message).toBe("stale_write");
    // Custom message stays opt-in for service-side context.
    expect(new StaleWriteError("update_product").message).toBe("update_product");
  });
});
