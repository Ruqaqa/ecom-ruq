/**
 * `delete_product` MCP tool — unit shape tests (authorize, isVisibleFor,
 * schema strictness, tx tripwire). Real integration is covered by
 * tests/integration/mcp/delete-product.test.ts.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  deleteProductTool,
  DeleteProductMcpInputSchema,
  DeleteProductMcpOutputSchema,
} from "@/server/mcp/tools/delete-product";
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
      scopes: { role, tools: ["delete_product"] },
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

describe("deleteProductTool — visibility/authorize", () => {
  it("visible+authorize OK for owner+staff", () => {
    expect(deleteProductTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
    expect(deleteProductTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
    expect(() => deleteProductTool.authorize(ctxBearer("owner"))).not.toThrow();
    expect(() => deleteProductTool.authorize(ctxBearer("staff"))).not.toThrow();
  });

  it("hidden+forbidden for support (non-write role)", () => {
    expect(deleteProductTool.isVisibleFor(ctxBearer("support"))).toBe(false);
    try {
      deleteProductTool.authorize(ctxBearer("support"));
      throw new Error("expected McpError");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
  });

  it("anonymous: hidden + unauthorized", () => {
    expect(deleteProductTool.isVisibleFor(ctxAnon)).toBe(false);
    try {
      deleteProductTool.authorize(ctxAnon);
      throw new Error("expected McpError");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("deleteProductTool — input schema", () => {
  it("rejects extra keys (.strict)", () => {
    const r = DeleteProductMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      confirm: true,
      tenantId: randomUUID(),
    });
    expect(r.success).toBe(false);
  });

  it("rejects missing confirm", () => {
    const r = DeleteProductMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
    });
    expect(r.success).toBe(false);
  });

  it("rejects confirm: false", () => {
    const r = DeleteProductMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      confirm: false,
    });
    expect(r.success).toBe(false);
  });

  it("accepts confirm: true with id + expectedUpdatedAt", () => {
    const r = DeleteProductMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      confirm: true,
    });
    expect(r.success).toBe(true);
  });
});

describe("deleteProductTool — handler tripwires", () => {
  it("tx===null path throws McpError(internal_error)", async () => {
    const ctx = ctxBearer("owner");
    await expect(
      deleteProductTool.handler(
        ctx,
        {
          id: randomUUID(),
          expectedUpdatedAt: new Date().toISOString(),
          confirm: true,
        },
        null,
      ),
    ).rejects.toMatchObject({ kind: "internal_error" });
  });
});

describe("deleteProductTool — output schema", () => {
  it("requires both id (uuid) and deletedAtIso (datetime)", () => {
    expect(
      DeleteProductMcpOutputSchema.safeParse({
        id: randomUUID(),
        deletedAtIso: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(
      DeleteProductMcpOutputSchema.safeParse({
        id: randomUUID(),
      }).success,
    ).toBe(false);
  });
});
