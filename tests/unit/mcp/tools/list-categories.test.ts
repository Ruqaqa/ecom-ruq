/**
 * `list_categories` MCP tool — unit tests for tool shape in isolation.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  listCategoriesTool,
  ListCategoriesMcpInputSchema,
  ListCategoriesMcpOutputSchema,
} from "@/server/mcp/tools/list-categories";
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
      scopes: { role, tools: ["list_categories"] },
    },
    correlationId: "cid-1",
    auditOverride: {},
  };
}

const ctxAnon: McpRequestContext = {
  tenant,
  identity: { type: "anonymous" },
  correlationId: "cid-anon",
  auditOverride: {},
};

describe("listCategoriesTool — isVisibleFor", () => {
  it("visible for owner / staff bearer", () => {
    expect(listCategoriesTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
    expect(listCategoriesTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
  });
  it("hidden for support bearer + anonymous", () => {
    expect(listCategoriesTool.isVisibleFor(ctxBearer("support"))).toBe(false);
    expect(listCategoriesTool.isVisibleFor(ctxAnon)).toBe(false);
  });
});

describe("listCategoriesTool — authorize", () => {
  it("owner / staff don't throw", () => {
    expect(() =>
      listCategoriesTool.authorize(ctxBearer("owner")),
    ).not.toThrow();
    expect(() =>
      listCategoriesTool.authorize(ctxBearer("staff")),
    ).not.toThrow();
  });
  it("support → forbidden, anon → unauthorized", () => {
    try {
      listCategoriesTool.authorize(ctxBearer("support"));
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
    try {
      listCategoriesTool.authorize(ctxAnon);
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("listCategoriesTool — input schema .strict()", () => {
  it("rejects extra key tenantId", () => {
    expect(
      ListCategoriesMcpInputSchema.safeParse({ tenantId: randomUUID() })
        .success,
    ).toBe(false);
  });
  it("rejects extra key role", () => {
    expect(
      ListCategoriesMcpInputSchema.safeParse({ role: "owner" }).success,
    ).toBe(false);
  });
  it("accepts empty input", () => {
    expect(ListCategoriesMcpInputSchema.safeParse({}).success).toBe(true);
  });
});

describe("listCategoriesTool — output schema", () => {
  it("parses an empty items envelope", () => {
    expect(ListCategoriesMcpOutputSchema.safeParse({ items: [] }).success).toBe(
      true,
    );
  });
});
