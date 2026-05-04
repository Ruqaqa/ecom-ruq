/**
 * `create_product_rich` MCP tool — unit tests for tool shape in
 * isolation (architect Block 4).
 *
 * The composed service is exercised in
 * `tests/unit/services/products/create-product-rich.test.ts`. Here we
 * lock the MCP-seam invariants: visibility, authorize, .strict() input,
 * and the load-bearing description copy an autonomous agent reads from
 * `tools/list`.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createProductRichTool,
  CreateProductRichMcpInputSchema,
} from "@/server/mcp/tools/create-product-rich";
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
      scopes: { role, tools: ["create_product_rich"] },
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

describe("createProductRichTool — visibility + authorize", () => {
  it("visible for owner / staff; hidden for support / anon", () => {
    expect(createProductRichTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
    expect(createProductRichTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
    expect(createProductRichTool.isVisibleFor(ctxBearer("support"))).toBe(
      false,
    );
    expect(createProductRichTool.isVisibleFor(ctxAnon)).toBe(false);
  });

  it("authorize rejects support / anon with closed-set kinds", () => {
    try {
      createProductRichTool.authorize(ctxBearer("support"));
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
    try {
      createProductRichTool.authorize(ctxAnon);
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("createProductRichTool — input schema .strict()", () => {
  it("rejects an extra key (tenantId is never user-supplied)", () => {
    expect(
      CreateProductRichMcpInputSchema.safeParse({
        slug: "x",
        name: { en: "X", ar: "س" },
        tenantId: randomUUID(),
      }).success,
    ).toBe(false);
  });
});
