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

  it("accepts a minimum-shaped input (slug + name)", () => {
    const r = CreateProductRichMcpInputSchema.safeParse({
      slug: "x",
      name: { en: "X", ar: "س" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an extra key inside an option", () => {
    expect(
      CreateProductRichMcpInputSchema.safeParse({
        slug: "x",
        name: { en: "X", ar: "س" },
        options: [
          {
            ref: "size",
            name: { en: "Size", ar: "م" },
            values: [{ ref: "s", value: { en: "S", ar: "ص" } }],
            extra: 1,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("createProductRichTool — description (load-bearing copy)", () => {
  it("declares all-or-nothing semantics", () => {
    const desc = createProductRichTool.description;
    expect(desc).toMatch(/all-or-nothing|atomic|single transaction/i);
  });

  it("declares the caps an agent must respect", () => {
    const desc = createProductRichTool.description;
    expect(desc).toMatch(/3 option/);
    expect(desc).toMatch(/100 value/);
    expect(desc).toMatch(/100 variant/);
    expect(desc).toMatch(/32 categor/);
  });

  it("describes what dryRun returns", () => {
    expect(createProductRichTool.description).toMatch(/dryRun/);
  });

  it("declares that local refs are call-scoped (not persisted)", () => {
    const desc = createProductRichTool.description;
    expect(desc).toMatch(/ref|local/i);
    expect(desc).toMatch(/not.*persist|call-scoped|never persist/i);
  });
});

describe("createProductRichTool — registry registration", () => {
  it("is registered in ALL_TOOLS with auditMode 'mutation'", async () => {
    const { ALL_TOOLS } = await import("@/server/mcp/tools/registry");
    const entry = ALL_TOOLS.find(
      (e) => e.tool.name === "create_product_rich",
    );
    expect(entry).toBeTruthy();
    expect(entry!.audit.auditMode).toBe("mutation");
  });
});
