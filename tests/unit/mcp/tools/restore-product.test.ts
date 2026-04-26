/**
 * `restore_product` MCP tool — unit shape tests. Symmetric to
 * delete_product. Real integration in
 * tests/integration/mcp/restore-product.test.ts.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  restoreProductTool,
  RestoreProductMcpInputSchema,
  RestoreProductMcpOutputSchema,
} from "@/server/mcp/tools/restore-product";
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
      scopes: { role, tools: ["restore_product"] },
    },
    correlationId: "cid-1",
    auditOverride: {},
  };
}

describe("restoreProductTool — visibility/authorize", () => {
  it("owner+staff visible+authorize OK; support hidden+forbidden", () => {
    expect(restoreProductTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
    expect(restoreProductTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
    expect(restoreProductTool.isVisibleFor(ctxBearer("support"))).toBe(false);
    try {
      restoreProductTool.authorize(ctxBearer("support"));
      throw new Error("expected McpError");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
  });
});

describe("restoreProductTool — input schema", () => {
  it("rejects extra keys (.strict) and missing/false confirm", () => {
    expect(
      RestoreProductMcpInputSchema.safeParse({
        id: randomUUID(),
        confirm: true,
        tenantId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      RestoreProductMcpInputSchema.safeParse({ id: randomUUID() }).success,
    ).toBe(false);
    expect(
      RestoreProductMcpInputSchema.safeParse({
        id: randomUUID(),
        confirm: false,
      }).success,
    ).toBe(false);
    expect(
      RestoreProductMcpInputSchema.safeParse({
        id: randomUUID(),
        confirm: true,
      }).success,
    ).toBe(true);
  });

  it("rejects expectedUpdatedAt — restore is OCC-free", () => {
    const r = RestoreProductMcpInputSchema.safeParse({
      id: randomUUID(),
      confirm: true,
      expectedUpdatedAt: new Date().toISOString(),
    });
    expect(r.success).toBe(false);
  });
});

describe("restoreProductTool — output schema", () => {
  it("requires id, deletedAtIso=null, updatedAtIso", () => {
    expect(
      RestoreProductMcpOutputSchema.safeParse({
        id: randomUUID(),
        deletedAtIso: null,
        updatedAtIso: new Date().toISOString(),
      }).success,
    ).toBe(true);
    // Non-null deletedAtIso rejected — restore guarantees null.
    expect(
      RestoreProductMcpOutputSchema.safeParse({
        id: randomUUID(),
        deletedAtIso: new Date().toISOString(),
        updatedAtIso: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});

describe("restoreProductTool — handler tripwires", () => {
  it("tx===null path throws McpError(internal_error)", async () => {
    const ctx = ctxBearer("owner");
    await expect(
      restoreProductTool.handler(
        ctx,
        { id: randomUUID(), confirm: true },
        null,
      ),
    ).rejects.toMatchObject({ kind: "internal_error" });
  });
});
