/**
 * `update_product` MCP tool — unit tests for the tool shape in isolation
 * (authorize, isVisibleFor, schema strictness, tx tripwire).
 *
 * Per docs/testing.md §3, per-tool MCP rules are tested at Tier 2.
 * Service-layer integration with runWithAudit + the real DB is covered
 * by the service-tier tests at tests/unit/services/products/. The MCP
 * transport itself (route handler, JSON-RPC envelope, cross-tenant
 * denial) is exercised once at Tier 3 by mcp-ping.test.ts.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  updateProductTool,
  UpdateProductMcpInputSchema,
} from "@/server/mcp/tools/update-product";
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
      scopes: { role, tools: ["update_product"] },
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

describe("updateProductTool — isVisibleFor", () => {
  it("visible for owner bearer", () => {
    expect(updateProductTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
  });

  it("visible for staff bearer", () => {
    expect(updateProductTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
  });

  it("hidden for support bearer — non-write role", () => {
    expect(updateProductTool.isVisibleFor(ctxBearer("support"))).toBe(false);
  });

  it("hidden for anonymous", () => {
    expect(updateProductTool.isVisibleFor(ctxAnon)).toBe(false);
  });
});

describe("updateProductTool — authorize (defense-in-depth)", () => {
  it("owner authorize does NOT throw", () => {
    expect(() => updateProductTool.authorize(ctxBearer("owner"))).not.toThrow();
  });

  it("staff authorize does NOT throw", () => {
    expect(() => updateProductTool.authorize(ctxBearer("staff"))).not.toThrow();
  });

  it("support authorize throws McpError('forbidden')", () => {
    try {
      updateProductTool.authorize(ctxBearer("support"));
      throw new Error("expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("forbidden");
    }
  });

  it("anonymous authorize throws McpError('unauthorized')", () => {
    try {
      updateProductTool.authorize(ctxAnon);
      throw new Error("expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("updateProductTool — input schema .strict() at MCP seam", () => {
  it("rejects adversarial extra key tenantId (cross-tenant attack surface)", () => {
    const result = UpdateProductMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      slug: "ok",
      tenantId: randomUUID(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra key `role` (input-channel role-elevation attack)", () => {
    const result = UpdateProductMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      slug: "ok",
      role: "owner",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty editable set (refine fires)", () => {
    const result = UpdateProductMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a minimal valid input (single editable key)", () => {
    const result = UpdateProductMcpInputSchema.safeParse({
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      slug: "valid-slug",
    });
    expect(result.success).toBe(true);
  });
});

describe("updateProductTool — handler tripwire", () => {
  it("throws McpError('internal_error') if dispatcher passes tx=null on mutation path", async () => {
    const ctx = ctxBearer("owner");
    const input = {
      id: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
      slug: "x",
    };
    try {
      await updateProductTool.handler(ctx, input, null);
      throw new Error("expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("internal_error");
    }
  });
});
