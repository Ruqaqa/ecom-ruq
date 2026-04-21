/**
 * `createMcpContext({ req })` tests.
 *
 * Contract:
 *   - Unknown host → McpUnknownHostError. HTTP route catches and returns
 *     a JSON-RPC envelope.
 *   - Known host + no Authorization → identity = anonymous (gating to
 *     401 is the HTTP route's job, not this module's).
 *   - Known host + valid Bearer → identity = bearer with role.
 *   - correlationId is a fresh UUID per call.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  createMcpContext,
  McpUnknownHostError,
} from "@/server/mcp/context";
import {
  __setTenantLookupLoaderForTests,
  clearTenantCacheForTests,
} from "@/server/tenant";
import { __setBearerLookupForTests } from "@/server/mcp/identity";
import type { BearerTokenRow } from "@/server/auth/bearer-lookup";

const KNOWN_HOST = "known.local";
const KNOWN_TENANT_ID = "00000000-0000-0000-0000-0000000000aa";

afterEach(() => {
  __setTenantLookupLoaderForTests(null);
  __setBearerLookupForTests(null);
  clearTenantCacheForTests();
});

function knownLoader(host: string) {
  if (host === KNOWN_HOST) {
    return {
      id: KNOWN_TENANT_ID,
      slug: "k",
      primaryDomain: KNOWN_HOST,
      defaultLocale: "en" as const,
      senderEmail: "no-reply@" + KNOWN_HOST,
      name: { en: "K", ar: "ك" },
    };
  }
  return null;
}

describe("createMcpContext", () => {
  it("throws McpUnknownHostError when the Host is unknown", async () => {
    __setTenantLookupLoaderForTests(async (host) => knownLoader(host));
    const req = new Request("http://unknown.local/api/mcp/streamable");
    await expect(createMcpContext({ req })).rejects.toBeInstanceOf(McpUnknownHostError);
  });

  it("returns a ctx with anonymous identity when Host is known but no Authorization header", async () => {
    __setTenantLookupLoaderForTests(async (host) => knownLoader(host));
    __setBearerLookupForTests(async () => null);
    const req = new Request(`http://${KNOWN_HOST}/api/mcp/streamable`);
    const ctx = await createMcpContext({ req });
    expect(ctx.tenant.id).toBe(KNOWN_TENANT_ID);
    expect(ctx.identity).toEqual({ type: "anonymous" });
    expect(typeof ctx.correlationId).toBe("string");
    expect(ctx.correlationId.length).toBeGreaterThan(10);
  });

  it("returns a ctx with bearer identity (role threaded through) on happy path", async () => {
    __setTenantLookupLoaderForTests(async (host) => knownLoader(host));
    const row: BearerTokenRow = {
      id: "tok-1",
      userId: "u-1",
      tenantId: KNOWN_TENANT_ID,
      name: "n",
      scopes: { role: "owner", tools: ["ping"] },
      effectiveRole: "owner",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    };
    __setBearerLookupForTests(async () => row);
    const req = new Request(`http://${KNOWN_HOST}/api/mcp/streamable`, {
      headers: { authorization: "Bearer eruq_pat_ok" },
    });
    const ctx = await createMcpContext({ req });
    expect(ctx.identity).toEqual({
      type: "bearer",
      userId: "u-1",
      tokenId: "tok-1",
      role: "owner",
      scopes: { role: "owner", tools: ["ping"] },
    });
  });

  it("mints a fresh correlationId on every call", async () => {
    __setTenantLookupLoaderForTests(async (host) => knownLoader(host));
    __setBearerLookupForTests(async () => null);
    const req1 = new Request(`http://${KNOWN_HOST}/api/mcp/streamable`);
    const req2 = new Request(`http://${KNOWN_HOST}/api/mcp/streamable`);
    const c1 = await createMcpContext({ req: req1 });
    const c2 = await createMcpContext({ req: req2 });
    expect(c1.correlationId).not.toBe(c2.correlationId);
  });
});
