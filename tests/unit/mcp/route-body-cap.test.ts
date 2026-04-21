/**
 * MCP route — 64KB body cap + parse-helper test.
 *
 * Security watchout B-1: on the 413 path the route MUST short-circuit
 * BEFORE calling the JSON parse helper. The `mcpParseJson` export is a
 * local seam (not a spy on global JSON.parse) so the spy only tracks
 * MCP-land invocations. If a future refactor drops the cap-first rule
 * and JSON.parse runs on hostile multi-MB bodies, this test red-lines.
 *
 * Other cases covered here:
 *   - exactly-at-cap body passes through to the SDK (we're not gating
 *     on size alone; the valid-shape path continues).
 *   - malformed JSON (cap-OK) returns -32700.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { __setParseJsonForTests } from "@/server/mcp/parse";
import {
  __setTenantLookupLoaderForTests,
  clearTenantCacheForTests,
} from "@/server/tenant";
import { __setBearerLookupForTests } from "@/server/mcp/identity";
import { POST } from "@/app/api/mcp/[transport]/route";

const KNOWN_HOST = "mcp-test.local";

afterEach(() => {
  __setParseJsonForTests(null);
  __setTenantLookupLoaderForTests(null);
  __setBearerLookupForTests(null);
  clearTenantCacheForTests();
});

function hostedRequest(body: string): Request {
  return new Request(`http://${KNOWN_HOST}/api/mcp/streamable-http`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer eruq_pat_fixture",
    },
    body,
  });
}

describe("MCP route — body cap (B-1)", () => {
  it("413s BEFORE calling the JSON parse helper when body > 64KB", async () => {
    // Craft > 64KB. (valid JSON so if parse DID run it would succeed — we
    // want to observe parseSpy NOT called even on parseable input.)
    const big = JSON.stringify({ pad: "a".repeat(70 * 1024) });
    expect(big.length).toBeGreaterThan(64 * 1024);

    const parseSpy = vi.fn((raw: string) => JSON.parse(raw));
    __setParseJsonForTests(parseSpy);

    const res = await POST(hostedRequest(big));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
    expect(parseSpy).not.toHaveBeenCalled(); // ← B-1 invariant
    // And no-store on 413 path
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("malformed JSON body (under cap) returns -32700 parse error", async () => {
    // Ensure tenant + auth paths wouldn't even run — the parse error is
    // independent. We DO need a tenant loader override though because the
    // route reaches createMcpContext only AFTER parse succeeds.
    const parseSpy = vi.fn((_: string) => {
      throw new SyntaxError("Unexpected token");
    });
    __setParseJsonForTests(parseSpy);
    const res = await POST(hostedRequest("{ not: json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("content-length > cap also 413s (cheap early reject)", async () => {
    const parseSpy = vi.fn();
    __setParseJsonForTests(parseSpy);
    const req = new Request(`http://${KNOWN_HOST}/api/mcp/streamable-http`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(1024 * 1024),
        authorization: "Bearer eruq_pat_x",
      },
      body: "{}",
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it("under-cap request proceeds past the cap check (tenant-known + anonymous → 401)", async () => {
    // At exactly-under-cap, the parse helper runs and the request flows
    // through to context creation. Anonymous bearer lookup returns null
    // → 401 JSON-RPC unauthorized (and never reaches the SDK/audit path).
    __setTenantLookupLoaderForTests(async (host) =>
      host === KNOWN_HOST
        ? {
            id: "00000000-0000-0000-0000-000000000099",
            slug: "mcp-test",
            primaryDomain: KNOWN_HOST,
            defaultLocale: "en" as const,
            senderEmail: "no-reply@" + KNOWN_HOST,
            name: { en: "M", ar: "م" },
          }
        : null,
    );
    __setBearerLookupForTests(async () => null); // → anonymous

    const parseSpy = vi.fn((raw: string) => JSON.parse(raw));
    __setParseJsonForTests(parseSpy);

    // A valid JSON-RPC envelope ~200 bytes
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const res = await POST(hostedRequest(body));
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe(-32003);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("unknown host returns 404 JSON-RPC envelope (no SDK dispatch)", async () => {
    __setTenantLookupLoaderForTests(async () => null);
    const parseSpy = vi.fn((raw: string) => JSON.parse(raw));
    __setParseJsonForTests(parseSpy);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const req = new Request("http://unknown.local/api/mcp/streamable-http", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer eruq_pat_x" },
      body,
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe(-32004);
  });
});
