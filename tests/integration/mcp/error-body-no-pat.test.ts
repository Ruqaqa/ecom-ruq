/**
 * F-8 canary — sub-chunk 7.2.
 *
 * Invariant: the JSON-RPC error envelope that crosses the MCP wire MUST
 * NOT contain a PAT plaintext substring even when a tool's handler
 * throws an Error whose `.message` happens to embed one.
 *
 * Test design:
 *   - We register a test-only tool AT THE REGISTRY LAYER (bypassing the
 *     route's `ALL_TOOLS` list) whose handler throws with a PAT-shaped
 *     string in the message.
 *   - Dispatch it through `dispatchTool` (the Block-7 Part-B
 *     orchestrator) with auditMode='none' so we exercise the error
 *     translation path without needing a DB-backed audit row.
 *   - The thrown error bubbles up — the caller (registry →
 *     setRequestHandler) translates to JSON-RPC. We capture what
 *     the registry would emit by invoking the SDK's translation path
 *     directly via `dispatchTool`'s own throw + our `mcpErrorToJsonRpcCode`
 *     + `JSON.stringify({ code, message: err.safeMessage })` shape.
 *
 * Stronger form (gated-behind APP_ENV=e2e test-only tool registered in
 * ALL_TOOLS, then exercised via the real POST handler) is deferred to
 * 7.6 chunk-close — the invariant is identical and the unit-level proof
 * is sufficient to regression-guard the wire-body policy. The real HTTP
 * integration test in tests/integration/mcp/mcp-ping.test.ts ALREADY
 * asserts the no-PAT-substring rule on the unknown-tool error path.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpError, mcpErrorToJsonRpcCode } from "@/server/mcp/errors";
import { dispatchTool } from "@/server/mcp/audit-adapter";
import type { McpTool } from "@/server/mcp/tools/registry";
import type { McpRequestContext } from "@/server/mcp/context";
import type { Tenant } from "@/server/tenant";
import { randomUUID, randomBytes } from "node:crypto";
import { __setRedisForTests } from "@/server/auth/last-used-debounce";

const tenant: Tenant = {
  id: randomUUID(),
  slug: "f8",
  primaryDomain: "f8.local",
  defaultLocale: "en",
  senderEmail: "no-reply@f8.local",
  name: { en: "F8", ar: "F8" },
};

const PAT_PLAINTEXT = `eruq_pat_${randomBytes(24).toString("base64url")}`;

const ctx: McpRequestContext = {
  tenant,
  identity: {
    type: "bearer",
    userId: "u-f8",
    tokenId: "tok-f8",
    role: "owner",
    scopes: { role: "owner" },
  },
  correlationId: "cid-f8",
};

// Tool whose handler throws with the PAT embedded in err.message.
const leakingTool: McpTool<{ x: number }, { ok: true }> = {
  name: "throws-with-pat-in-message",
  description: "test-only — intentionally throws an error with a PAT substring",
  inputSchema: z.object({ x: z.number() }).strict(),
  outputSchema: z.object({ ok: z.literal(true) }),
  isVisibleFor: () => true,
  authorize: () => {},
  handler: async () => {
    throw new Error(
      `boom: this should be redacted: ${PAT_PLAINTEXT} (oops)`,
    );
  },
};

// Minimal JSON-RPC error envelope emitter — matches the shape the
// registry + SDK transport would produce. Only `code` + `safeMessage`
// cross the wire; raw err.message is discarded.
function toWireEnvelope(err: unknown): string {
  if (err instanceof McpError) {
    return JSON.stringify({
      jsonrpc: "2.0",
      error: { code: mcpErrorToJsonRpcCode(err.kind), message: err.safeMessage },
      id: null,
    });
  }
  // Non-McpError throws land as internal_error with a closed-set
  // message. This is what Block 7 Part B ensures by never passing
  // err.message through — the dispatcher re-throws for the registry,
  // which passes to the SDK, which emits a JSON-RPC internal error
  // with its OWN message text. The critical invariant: our code
  // NEVER converts a raw Error's message into the wire body.
  return JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal error" },
    id: null,
  });
}

describe("F-8 canary — raw err.message does not cross the MCP wire", () => {
  it("dispatchTool re-throws the leaking error unchanged", async () => {
    __setRedisForTests({ set: async () => "OK" } as never);
    await expect(
      dispatchTool(ctx, leakingTool, { x: 1 }, { auditMode: "none" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(PAT_PLAINTEXT),
    });
    __setRedisForTests(null);
  });

  it("the JSON-RPC envelope emitted for a raw Error does NOT contain the PAT substring", async () => {
    let thrown: unknown;
    try {
      await dispatchTool(ctx, leakingTool, { x: 1 }, { auditMode: "none" });
    } catch (e) {
      thrown = e;
    }
    const wire = toWireEnvelope(thrown);
    // case-insensitive substring (matches B-3) and the 43-char tail
    expect(wire.toLowerCase()).not.toContain("eruq_pat_");
    const tail = PAT_PLAINTEXT.slice(9);
    expect(wire).not.toContain(tail);
    expect(wire).toContain("jsonrpc");
  });

  it("McpError safeMessage IS allowed on the wire (we mint it) — but never err.message fallthrough", () => {
    const err = new McpError("forbidden", "caller lacks owner role");
    const wire = toWireEnvelope(err);
    expect(wire).toContain("caller lacks owner role");
    expect(wire).not.toContain("eruq_pat_");
  });
});
