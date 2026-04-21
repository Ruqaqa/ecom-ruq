/**
 * `ping` MCP tool tests.
 *
 * Contract:
 *   - Bearer owner → `{ ok: true, tenantId, role: "owner" }`.
 *   - Bearer staff → role: "staff".
 *   - Anonymous → authorize throws McpError("unauthorized").
 *   - Input schema is strict — an extra key rejects via Zod.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  pingTool,
  PingInputSchema,
  PingOutputSchema,
} from "@/server/mcp/tools/ping";
import { McpError } from "@/server/mcp/errors";
import type { McpRequestContext } from "@/server/mcp/context";
import type { Tenant } from "@/server/tenant";

const tenant: Tenant = {
  id: randomUUID(),
  slug: "t",
  primaryDomain: "t.local",
  defaultLocale: "en",
  senderEmail: "no-reply@t.local",
  name: { en: "T", ar: "ت" },
};

function ctxBearer(role: "owner" | "staff" | "support"): McpRequestContext {
  return {
    tenant,
    identity: {
      type: "bearer",
      userId: "u-1",
      tokenId: "tok-1",
      role,
      scopes: { role, tools: ["ping"] },
    },
    correlationId: "cid-1",
  };
}
const ctxAnon: McpRequestContext = {
  tenant,
  identity: { type: "anonymous" },
  correlationId: "cid-anon",
};

describe("pingTool", () => {
  it("echoes { ok, tenantId, role } for an owner bearer caller", async () => {
    const ctx = ctxBearer("owner");
    pingTool.authorize(ctx); // no throw
    const input = PingInputSchema.parse({});
    const raw = await pingTool.handler(ctx, input);
    const out = PingOutputSchema.parse(raw);
    expect(out).toEqual({ ok: true, tenantId: tenant.id, role: "owner" });
  });

  it("echoes role=staff for a staff bearer caller", async () => {
    const ctx = ctxBearer("staff");
    pingTool.authorize(ctx);
    const input = PingInputSchema.parse({});
    const raw = await pingTool.handler(ctx, input);
    expect(raw.role).toBe("staff");
  });

  it("authorize throws McpError('unauthorized') for an anonymous caller", () => {
    expect(() => pingTool.authorize(ctxAnon)).toThrow(McpError);
    try {
      pingTool.authorize(ctxAnon);
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("unauthorized");
    }
  });

  it("isVisibleFor: true for bearer, false for anonymous", () => {
    expect(pingTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
    expect(pingTool.isVisibleFor(ctxAnon)).toBe(false);
  });

  it("input schema is .strict() — rejects extra keys", () => {
    // A hostile caller who supplies { extra: "junk" } gets a Zod
    // BAD_REQUEST, not silent pass-through. That's the first line of
    // defense in Tier-B output gating.
    const result = PingInputSchema.safeParse({ extra: "junk" });
    expect(result.success).toBe(false);
  });

  it("output schema refuses unknown role values (Tier-B guard)", () => {
    const result = PingOutputSchema.safeParse({
      ok: true,
      tenantId: tenant.id,
      role: "customer",
    });
    expect(result.success).toBe(false);
  });
});
