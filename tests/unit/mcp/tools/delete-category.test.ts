/**
 * `delete_category` MCP tool — unit shape tests (visibility/authorize,
 * .strict input, output schema, tx tripwire). Mirrors `delete_product`.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  deleteCategoryTool,
  DeleteCategoryMcpInputSchema,
  DeleteCategoryMcpOutputSchema,
} from "@/server/mcp/tools/delete-category";
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
      scopes: { role, tools: ["delete_category"] },
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

describe("deleteCategoryTool — visibility/authorize", () => {
  it("visible+authorize OK for owner+staff", () => {
    expect(deleteCategoryTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
    expect(deleteCategoryTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
    expect(() => deleteCategoryTool.authorize(ctxBearer("owner"))).not.toThrow();
    expect(() => deleteCategoryTool.authorize(ctxBearer("staff"))).not.toThrow();
  });

  it("hidden+forbidden for support (non-write role)", () => {
    expect(deleteCategoryTool.isVisibleFor(ctxBearer("support"))).toBe(false);
    try {
      deleteCategoryTool.authorize(ctxBearer("support"));
      throw new Error("expected McpError");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
  });

  it("anonymous: hidden + unauthorized", () => {
    expect(deleteCategoryTool.isVisibleFor(ctxAnon)).toBe(false);
    try {
      deleteCategoryTool.authorize(ctxAnon);
      throw new Error("expected McpError");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("deleteCategoryTool — description", () => {
  it("makes the cascade behavior explicit (owner reads this in the MCP client)", () => {
    expect(deleteCategoryTool.description.toLowerCase()).toMatch(
      /every category beneath/i,
    );
  });
});

describe("deleteCategoryTool — input schema", () => {
  it("rejects extra keys (.strict)", () => {
    const r = DeleteCategoryMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      confirm: true,
      tenantId: randomUUID(),
    });
    expect(r.success).toBe(false);
  });

  it("rejects missing confirm", () => {
    const r = DeleteCategoryMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
    });
    expect(r.success).toBe(false);
  });

  it("rejects confirm: false", () => {
    const r = DeleteCategoryMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      confirm: false,
    });
    expect(r.success).toBe(false);
  });

  it("accepts confirm: true with id + expectedUpdatedAt", () => {
    const r = DeleteCategoryMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      confirm: true,
    });
    expect(r.success).toBe(true);
  });
});

describe("deleteCategoryTool — output schema", () => {
  it("requires id (uuid), deletedAtIso (datetime), and cascadedIds (uuid[])", () => {
    expect(
      DeleteCategoryMcpOutputSchema.safeParse({
        id: randomUUID(),
        deletedAtIso: new Date().toISOString(),
        cascadedIds: [randomUUID()],
      }).success,
    ).toBe(true);
    expect(
      DeleteCategoryMcpOutputSchema.safeParse({
        id: randomUUID(),
        deletedAtIso: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});

describe("deleteCategoryTool — handler tripwires", () => {
  it("tx===null path throws McpError(internal_error)", async () => {
    const ctx = ctxBearer("owner");
    await expect(
      deleteCategoryTool.handler(
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
