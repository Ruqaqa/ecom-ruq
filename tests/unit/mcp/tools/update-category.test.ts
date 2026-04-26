/**
 * `update_category` MCP tool — unit tests for tool shape in isolation.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  updateCategoryTool,
  UpdateCategoryMcpInputSchema,
} from "@/server/mcp/tools/update-category";
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
      scopes: { role, tools: ["update_category"] },
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

describe("updateCategoryTool — visibility + authorize", () => {
  it("visible for owner / staff; hidden otherwise", () => {
    expect(updateCategoryTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
    expect(updateCategoryTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
    expect(updateCategoryTool.isVisibleFor(ctxBearer("support"))).toBe(false);
    expect(updateCategoryTool.isVisibleFor(ctxAnon)).toBe(false);
  });
  it("authorize rejects support / anon", () => {
    try {
      updateCategoryTool.authorize(ctxBearer("support"));
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
    try {
      updateCategoryTool.authorize(ctxAnon);
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("updateCategoryTool — input schema .strict()", () => {
  it("rejects extra key tenantId", () => {
    expect(
      UpdateCategoryMcpInputSchema.safeParse({
        id: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        tenantId: randomUUID(),
        position: 1,
      }).success,
    ).toBe(false);
  });
  it("rejects empty editable set (refine fires)", () => {
    expect(
      UpdateCategoryMcpInputSchema.safeParse({
        id: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
  it("accepts minimal valid input (single editable key)", () => {
    expect(
      UpdateCategoryMcpInputSchema.safeParse({
        id: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        position: 7,
      }).success,
    ).toBe(true);
  });
});

describe("updateCategoryTool — handler tripwire", () => {
  it("throws McpError('internal_error') on tx=null", async () => {
    try {
      await updateCategoryTool.handler(
        ctxBearer("owner"),
        {
          id: randomUUID(),
          expectedUpdatedAt: new Date().toISOString(),
          position: 1,
        },
        null,
      );
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("internal_error");
    }
  });
});
