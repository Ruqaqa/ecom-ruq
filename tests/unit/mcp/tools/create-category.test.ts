/**
 * `create_category` MCP tool — unit tests for tool shape in isolation.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createCategoryTool,
  CreateCategoryMcpInputSchema,
} from "@/server/mcp/tools/create-category";
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
      scopes: { role, tools: ["create_category"] },
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

describe("createCategoryTool — isVisibleFor", () => {
  it("visible for owner + staff", () => {
    expect(createCategoryTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
    expect(createCategoryTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
  });
  it("hidden for support + anon", () => {
    expect(createCategoryTool.isVisibleFor(ctxBearer("support"))).toBe(false);
    expect(createCategoryTool.isVisibleFor(ctxAnon)).toBe(false);
  });
});

describe("createCategoryTool — authorize", () => {
  it("support → forbidden", () => {
    try {
      createCategoryTool.authorize(ctxBearer("support"));
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
  });
  it("anon → unauthorized", () => {
    try {
      createCategoryTool.authorize(ctxAnon);
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("createCategoryTool — input schema .strict()", () => {
  it("rejects extra key tenantId (cross-tenant attack)", () => {
    expect(
      CreateCategoryMcpInputSchema.safeParse({
        slug: "x",
        name: { en: "X", ar: "س" },
        tenantId: randomUUID(),
      }).success,
    ).toBe(false);
  });
  it("rejects extra key role (input-channel role-elevation)", () => {
    expect(
      CreateCategoryMcpInputSchema.safeParse({
        slug: "x",
        name: { en: "X", ar: "س" },
        role: "owner",
      }).success,
    ).toBe(false);
  });
  it("accepts a minimal valid input", () => {
    expect(
      CreateCategoryMcpInputSchema.safeParse({
        slug: "ok",
        name: { en: "X", ar: "س" },
      }).success,
    ).toBe(true);
  });
  it("rejects bad slug shape (uppercase)", () => {
    expect(
      CreateCategoryMcpInputSchema.safeParse({
        slug: "Bad",
        name: { en: "X", ar: "س" },
      }).success,
    ).toBe(false);
  });
});

describe("createCategoryTool — handler tripwire", () => {
  it("throws McpError('internal_error') if dispatcher passes tx=null", async () => {
    try {
      await createCategoryTool.handler(
        ctxBearer("owner"),
        { slug: "ok", name: { en: "X", ar: "س" } },
        null,
      );
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("internal_error");
    }
  });
});
