/**
 * `restore_category` MCP tool — unit shape tests. Symmetric to
 * `restore_product`. Single-row only — the description must say so.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  restoreCategoryTool,
  RestoreCategoryMcpInputSchema,
  RestoreCategoryMcpOutputSchema,
} from "@/server/mcp/tools/restore-category";
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
      scopes: { role, tools: ["restore_category"] },
    },
    correlationId: "cid-1",
    auditOverride: {},
  };
}

describe("restoreCategoryTool — visibility/authorize", () => {
  it("owner+staff visible+authorize OK; support hidden+forbidden", () => {
    expect(restoreCategoryTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
    expect(restoreCategoryTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
    expect(restoreCategoryTool.isVisibleFor(ctxBearer("support"))).toBe(false);
    try {
      restoreCategoryTool.authorize(ctxBearer("support"));
      throw new Error("expected McpError");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
  });
});

describe("restoreCategoryTool — description", () => {
  it("makes the single-row scope explicit (sub-categories restored individually)", () => {
    // Owner reads this in the MCP client; cascade-restore is NOT supported.
    expect(restoreCategoryTool.description).toMatch(
      /sub-categories must be restored individually/i,
    );
  });
});

describe("restoreCategoryTool — input schema", () => {
  it("rejects extra keys (.strict) and missing/false confirm", () => {
    expect(
      RestoreCategoryMcpInputSchema.safeParse({
        id: randomUUID(),
        confirm: true,
        tenantId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      RestoreCategoryMcpInputSchema.safeParse({ id: randomUUID() }).success,
    ).toBe(false);
    expect(
      RestoreCategoryMcpInputSchema.safeParse({
        id: randomUUID(),
        confirm: false,
      }).success,
    ).toBe(false);
    expect(
      RestoreCategoryMcpInputSchema.safeParse({
        id: randomUUID(),
        confirm: true,
      }).success,
    ).toBe(true);
  });

  it("rejects expectedUpdatedAt — restore is OCC-free", () => {
    const r = RestoreCategoryMcpInputSchema.safeParse({
      id: randomUUID(),
      confirm: true,
      expectedUpdatedAt: new Date().toISOString(),
    });
    expect(r.success).toBe(false);
  });
});

describe("restoreCategoryTool — output schema", () => {
  it("requires id, deletedAtIso=null, updatedAtIso", () => {
    expect(
      RestoreCategoryMcpOutputSchema.safeParse({
        id: randomUUID(),
        deletedAtIso: null,
        updatedAtIso: new Date().toISOString(),
      }).success,
    ).toBe(true);
    // Non-null deletedAtIso rejected — restore guarantees null.
    expect(
      RestoreCategoryMcpOutputSchema.safeParse({
        id: randomUUID(),
        deletedAtIso: new Date().toISOString(),
        updatedAtIso: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});

describe("restoreCategoryTool — handler tripwires", () => {
  it("tx===null path throws McpError(internal_error)", async () => {
    const ctx = ctxBearer("owner");
    await expect(
      restoreCategoryTool.handler(
        ctx,
        { id: randomUUID(), confirm: true },
        null,
      ),
    ).rejects.toMatchObject({ kind: "internal_error" });
  });
});
