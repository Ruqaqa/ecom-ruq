/**
 * `set_product_categories` MCP tool — unit tests for tool shape in isolation.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  setProductCategoriesTool,
  SetProductCategoriesMcpInputSchema,
} from "@/server/mcp/tools/set-product-categories";
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
      scopes: { role, tools: ["set_product_categories"] },
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

describe("setProductCategoriesTool — visibility + authorize", () => {
  it("visible for owner / staff; hidden for support / anon", () => {
    expect(setProductCategoriesTool.isVisibleFor(ctxBearer("owner"))).toBe(
      true,
    );
    expect(setProductCategoriesTool.isVisibleFor(ctxBearer("staff"))).toBe(
      true,
    );
    expect(setProductCategoriesTool.isVisibleFor(ctxBearer("support"))).toBe(
      false,
    );
    expect(setProductCategoriesTool.isVisibleFor(ctxAnon)).toBe(false);
  });

  it("authorize rejects support / anon with closed-set kinds", () => {
    try {
      setProductCategoriesTool.authorize(ctxBearer("support"));
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
    try {
      setProductCategoriesTool.authorize(ctxAnon);
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("setProductCategoriesTool — input schema .strict()", () => {
  it("rejects extra key tenantId", () => {
    expect(
      SetProductCategoriesMcpInputSchema.safeParse({
        productId: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        categoryIds: [],
        tenantId: randomUUID(),
      }).success,
    ).toBe(false);
  });

  it("accepts empty array (detach all)", () => {
    expect(
      SetProductCategoriesMcpInputSchema.safeParse({
        productId: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        categoryIds: [],
      }).success,
    ).toBe(true);
  });

  it("rejects 33-element array", () => {
    const ids = Array.from({ length: 33 }, () => randomUUID());
    expect(
      SetProductCategoriesMcpInputSchema.safeParse({
        productId: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        categoryIds: ids,
      }).success,
    ).toBe(false);
  });

  it("accepts duplicate ids — dedupe happens in the service body", () => {
    const id = randomUUID();
    const result = SetProductCategoriesMcpInputSchema.safeParse({
      productId: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      categoryIds: [id, id, id],
    });
    expect(result.success).toBe(true);
  });
});

describe("setProductCategoriesTool — handler tripwire", () => {
  it("throws McpError('internal_error') on tx=null", async () => {
    try {
      await setProductCategoriesTool.handler(
        ctxBearer("owner"),
        {
          productId: randomUUID(),
          expectedUpdatedAt: new Date().toISOString(),
          categoryIds: [],
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
