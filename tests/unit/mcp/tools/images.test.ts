/**
 * MCP image tools — unit tests for tool shape in isolation
 * (chunk 1a.7.1 Block 6).
 *
 * Five tools:
 *   list_product_images        — auditMode:"none"
 *   delete_product_image       — auditMode:"mutation", confirm:true
 *   set_product_cover_image    — auditMode:"mutation"
 *   set_variant_cover_image    — auditMode:"mutation"
 *   set_product_image_alt_text — auditMode:"mutation"
 *
 * Coverage per tool: isVisibleFor (write-role gate), authorize
 * (defense-in-depth gate), .strict() input schema rejection of extra
 * keys, confirm:true rejection on the destructive tool, tx-wiring
 * invariant on mutation-mode tools (handler throws when tx is null).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { listProductImagesTool } from "@/server/mcp/tools/list-product-images";
import { deleteProductImageTool } from "@/server/mcp/tools/delete-product-image";
import { setProductCoverImageTool } from "@/server/mcp/tools/set-product-cover-image";
import { setVariantCoverImageTool } from "@/server/mcp/tools/set-variant-cover-image";
import { setProductImageAltTextTool } from "@/server/mcp/tools/set-product-image-alt-text";
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
      scopes: { role, tools: [] },
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

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_2 = "22222222-2222-4222-8222-222222222222";
const VALID_ISO = "2026-01-01T00:00:00.000Z";

describe.each([
  ["list_product_images", listProductImagesTool],
  ["delete_product_image", deleteProductImageTool],
  ["set_product_cover_image", setProductCoverImageTool],
  ["set_variant_cover_image", setVariantCoverImageTool],
  ["set_product_image_alt_text", setProductImageAltTextTool],
] as const)("%s — visibility + authorize", (name, tool) => {
  it("visible for owner bearer", () => {
    expect(tool.isVisibleFor(ctxBearer("owner"))).toBe(true);
  });
  it("visible for staff bearer", () => {
    expect(tool.isVisibleFor(ctxBearer("staff"))).toBe(true);
  });
  it("hidden for support bearer (read-only role)", () => {
    expect(tool.isVisibleFor(ctxBearer("support"))).toBe(false);
  });
  it("hidden for anonymous", () => {
    expect(tool.isVisibleFor(ctxAnon)).toBe(false);
  });

  it("owner authorize does not throw", () => {
    expect(() => tool.authorize(ctxBearer("owner"))).not.toThrow();
  });
  it("staff authorize does not throw", () => {
    expect(() => tool.authorize(ctxBearer("staff"))).not.toThrow();
  });
  it("support authorize throws McpError(forbidden)", () => {
    try {
      tool.authorize(ctxBearer("support"));
      throw new Error(`${name} should have thrown`);
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("forbidden");
    }
  });
  it("anonymous authorize throws McpError(unauthorized)", () => {
    try {
      tool.authorize(ctxAnon);
      throw new Error(`${name} should have thrown`);
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("input schema strictness — extra keys rejected", () => {
  it("list_product_images rejects extra keys", () => {
    const result = listProductImagesTool.inputSchema.safeParse({
      productId: VALID_UUID,
      extraKey: "value",
    });
    expect(result.success).toBe(false);
  });

  it("delete_product_image rejects without confirm:true", () => {
    const result = deleteProductImageTool.inputSchema.safeParse({
      imageId: VALID_UUID,
      expectedUpdatedAt: VALID_ISO,
    });
    expect(result.success).toBe(false);
  });

  it("delete_product_image rejects confirm:false", () => {
    const result = deleteProductImageTool.inputSchema.safeParse({
      imageId: VALID_UUID,
      expectedUpdatedAt: VALID_ISO,
      confirm: false,
    });
    expect(result.success).toBe(false);
  });

  it("delete_product_image accepts a valid input with confirm:true", () => {
    const result = deleteProductImageTool.inputSchema.safeParse({
      imageId: VALID_UUID,
      expectedUpdatedAt: VALID_ISO,
      confirm: true,
    });
    expect(result.success).toBe(true);
  });

  it("set_product_cover_image rejects extra keys", () => {
    const result = setProductCoverImageTool.inputSchema.safeParse({
      imageId: VALID_UUID,
      expectedUpdatedAt: VALID_ISO,
      extraKey: "v",
    });
    expect(result.success).toBe(false);
  });

  it("set_variant_cover_image accepts imageId:null (clearing the cover)", () => {
    const result = setVariantCoverImageTool.inputSchema.safeParse({
      variantId: VALID_UUID,
      imageId: null,
      expectedUpdatedAt: VALID_ISO,
    });
    expect(result.success).toBe(true);
  });

  it("set_variant_cover_image accepts imageId:<uuid>", () => {
    const result = setVariantCoverImageTool.inputSchema.safeParse({
      variantId: VALID_UUID,
      imageId: VALID_UUID_2,
      expectedUpdatedAt: VALID_ISO,
    });
    expect(result.success).toBe(true);
  });

  it("set_product_image_alt_text accepts altText:null (clearing both sides)", () => {
    const result = setProductImageAltTextTool.inputSchema.safeParse({
      imageId: VALID_UUID,
      expectedUpdatedAt: VALID_ISO,
      altText: null,
    });
    expect(result.success).toBe(true);
  });

  it("set_product_image_alt_text accepts a partial pair (en only)", () => {
    const result = setProductImageAltTextTool.inputSchema.safeParse({
      imageId: VALID_UUID,
      expectedUpdatedAt: VALID_ISO,
      altText: { en: "english only" },
    });
    expect(result.success).toBe(true);
  });
});

describe("tx-wiring invariant — mutation-mode handlers throw on tx===null", () => {
  it.each([
    ["delete_product_image", deleteProductImageTool, {
      imageId: VALID_UUID,
      expectedUpdatedAt: VALID_ISO,
      confirm: true as const,
    }],
    ["set_product_cover_image", setProductCoverImageTool, {
      imageId: VALID_UUID,
      expectedUpdatedAt: VALID_ISO,
    }],
    ["set_variant_cover_image", setVariantCoverImageTool, {
      variantId: VALID_UUID,
      imageId: null,
      expectedUpdatedAt: VALID_ISO,
    }],
    ["set_product_image_alt_text", setProductImageAltTextTool, {
      imageId: VALID_UUID,
      expectedUpdatedAt: VALID_ISO,
      altText: null,
    }],
  ] as const)("%s rejects tx=null with internal_error", async (_name, tool, input) => {
    let caught: unknown = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await tool.handler(ctxBearer("owner"), input as any, null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).kind).toBe("internal_error");
  });
});
