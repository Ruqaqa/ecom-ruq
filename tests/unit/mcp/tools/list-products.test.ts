/**
 * `list_products` MCP tool — unit tests for tool shape in isolation.
 * Integration with the real HTTP route + DB lands in
 * tests/integration/mcp/list-products.test.ts.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  listProductsTool,
  ListProductsMcpInputSchema,
  ListProductsMcpOutputSchema,
} from "@/server/mcp/tools/list-products";
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

function ctxBearer(
  role: "owner" | "staff" | "support",
): McpRequestContext {
  return {
    tenant,
    identity: {
      type: "bearer",
      userId: "u-1",
      tokenId: "tok-1",
      role,
      scopes: { role, tools: ["list_products"] },
    },
    correlationId: "cid-1",
  };
}

const ctxAnon: McpRequestContext = {
  tenant,
  identity: { type: "anonymous" },
  correlationId: "cid-anon",
};

describe("listProductsTool — isVisibleFor (hide from non-write roles)", () => {
  it("visible for owner bearer", () => {
    expect(listProductsTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
  });
  it("visible for staff bearer", () => {
    expect(listProductsTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
  });
  it("hidden for support bearer", () => {
    expect(listProductsTool.isVisibleFor(ctxBearer("support"))).toBe(false);
  });
  it("hidden for anonymous", () => {
    expect(listProductsTool.isVisibleFor(ctxAnon)).toBe(false);
  });
});

describe("listProductsTool — authorize (defense-in-depth)", () => {
  it("owner authorize does NOT throw", () => {
    expect(() => listProductsTool.authorize(ctxBearer("owner"))).not.toThrow();
  });
  it("staff authorize does NOT throw", () => {
    expect(() => listProductsTool.authorize(ctxBearer("staff"))).not.toThrow();
  });
  it("support authorize throws McpError('forbidden')", () => {
    try {
      listProductsTool.authorize(ctxBearer("support"));
      throw new Error("expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("forbidden");
    }
  });
  it("anonymous authorize throws McpError('unauthorized')", () => {
    try {
      listProductsTool.authorize(ctxAnon);
      throw new Error("expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("listProductsTool — input schema .strict()", () => {
  it("rejects extra key tenantId (cross-tenant attack surface)", () => {
    const r = ListProductsMcpInputSchema.safeParse({
      tenantId: randomUUID(),
    });
    expect(r.success).toBe(false);
  });
  it("rejects extra key role (role-elevation attack)", () => {
    const r = ListProductsMcpInputSchema.safeParse({ role: "owner" });
    expect(r.success).toBe(false);
  });
  it("rejects limit above cap (101)", () => {
    const r = ListProductsMcpInputSchema.safeParse({ limit: 101 });
    expect(r.success).toBe(false);
  });
  it("rejects limit=0", () => {
    const r = ListProductsMcpInputSchema.safeParse({ limit: 0 });
    expect(r.success).toBe(false);
  });
  it("accepts empty input (MCP default limit = 10)", () => {
    const r = ListProductsMcpInputSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(10);
  });
  it("accepts explicit valid input", () => {
    const r = ListProductsMcpInputSchema.safeParse({
      limit: 50,
      cursor: "abc",
    });
    expect(r.success).toBe(true);
  });
});

describe("listProductsTool — output schema", () => {
  it("parses an owner-shape envelope successfully", () => {
    const sample = {
      items: [
        {
          id: randomUUID(),
          slug: "p-1",
          name: { en: "A", ar: "أ" },
          description: null,
          status: "draft" as const,
          categoryId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          costPriceMinor: 1000,
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
    const r = ListProductsMcpOutputSchema.safeParse(sample);
    expect(r.success).toBe(true);
  });

  it("parses an empty-items envelope successfully", () => {
    const r = ListProductsMcpOutputSchema.safeParse({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(r.success).toBe(true);
  });
});

describe("listProductsTool — description hygiene", () => {
  it("does not mention tenantId as an argument (AI-read surface, security H-3)", () => {
    expect(listProductsTool.description.toLowerCase()).not.toContain("tenantid");
  });
  it("does not mention role as an argument", () => {
    // The word "role" can appear in role-gating prose ("owner or staff role");
    // we only guard against advertising role as an *input argument name*.
    expect(listProductsTool.description).not.toMatch(/role:\s|role\s*=|input.*role/i);
  });
});
