/**
 * `create_product` MCP tool — unit tests for the tool shape in isolation
 * (authorize, isVisibleFor, schema strictness, tx tripwire).
 *
 * Integration with runWithAudit + the service fn + the DB is covered
 * by tests/integration/mcp/create-product.test.ts (the Phase 0 exit
 * proof for this tool).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createProductTool,
  CreateProductMcpInputSchema,
} from "@/server/mcp/tools/create-product";
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
      scopes: { role, tools: ["create_product"] },
    },
    correlationId: "cid-1",
  };
}

const ctxAnon: McpRequestContext = {
  tenant,
  identity: { type: "anonymous" },
  correlationId: "cid-anon",
};

describe("createProductTool — isVisibleFor (Decision 2: HIDE)", () => {
  it("visible for owner bearer", () => {
    expect(createProductTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
  });

  it("visible for staff bearer", () => {
    expect(createProductTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
  });

  it("hidden for support bearer — non-write role", () => {
    expect(createProductTool.isVisibleFor(ctxBearer("support"))).toBe(false);
  });

  it("hidden for anonymous", () => {
    expect(createProductTool.isVisibleFor(ctxAnon)).toBe(false);
  });
});

describe("createProductTool — authorize (defense-in-depth)", () => {
  it("owner authorize does NOT throw", () => {
    expect(() => createProductTool.authorize(ctxBearer("owner"))).not.toThrow();
  });

  it("staff authorize does NOT throw", () => {
    expect(() => createProductTool.authorize(ctxBearer("staff"))).not.toThrow();
  });

  it("support authorize throws McpError('forbidden')", () => {
    try {
      createProductTool.authorize(ctxBearer("support"));
      throw new Error("expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("forbidden");
    }
  });

  it("anonymous authorize throws McpError('unauthorized')", () => {
    try {
      createProductTool.authorize(ctxAnon);
      throw new Error("expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("createProductTool — input schema .strict() at MCP seam", () => {
  it("rejects adversarial extra key tenantId", () => {
    // The exact attack shape from the integration test: a tenant-A PAT
    // tries to call `create_product` with `tenantId: "<tenantB>"` in
    // the body. `.strict()` at this seam makes that a Zod validation
    // failure before the service fn ever runs.
    const result = CreateProductMcpInputSchema.safeParse({
      slug: "tenantId-attack",
      name: { en: "X", ar: "س" },
      tenantId: randomUUID(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra key `role` (input-channel role-elevation attack)", () => {
    const result = CreateProductMcpInputSchema.safeParse({
      slug: "role-attack",
      name: { en: "X", ar: "س" },
      role: "owner",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a minimal valid input", () => {
    const result = CreateProductMcpInputSchema.safeParse({
      slug: "valid-product",
      name: { en: "X", ar: "س" },
    });
    expect(result.success).toBe(true);
  });
});

describe("createProductTool — handler tripwire", () => {
  it("throws McpError('internal_error') if dispatcher passes tx=null on mutation path", async () => {
    const ctx = ctxBearer("owner");
    const input = {
      slug: "a",
      name: { en: "A", ar: "أ" },
    };
    try {
      await createProductTool.handler(ctx, input, null);
      throw new Error("expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("internal_error");
    }
  });
});
