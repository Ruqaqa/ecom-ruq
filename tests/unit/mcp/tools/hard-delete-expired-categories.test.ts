/**
 * `hard_delete_expired_categories` MCP tool — unit shape tests.
 * Owner-only (tighter than write-role). Schema must require confirm even
 * with dryRun. Mirrors `hard_delete_expired_products`.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  hardDeleteExpiredCategoriesTool,
  HardDeleteExpiredCategoriesMcpInputSchema,
  HardDeleteExpiredCategoriesMcpOutputSchema,
} from "@/server/mcp/tools/hard-delete-expired-categories";
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
      scopes: { role, tools: ["hard_delete_expired_categories"] },
    },
    correlationId: "cid-1",
    auditOverride: {},
  };
}

describe("hardDeleteExpiredCategoriesTool — visibility/authorize (owner-only)", () => {
  it("owner is the only role that sees and can call this tool", () => {
    expect(
      hardDeleteExpiredCategoriesTool.isVisibleFor(ctxBearer("owner")),
    ).toBe(true);
    // Staff: must NOT be visible — owner-only sweeper.
    expect(
      hardDeleteExpiredCategoriesTool.isVisibleFor(ctxBearer("staff")),
    ).toBe(false);
    expect(
      hardDeleteExpiredCategoriesTool.isVisibleFor(ctxBearer("support")),
    ).toBe(false);

    expect(() =>
      hardDeleteExpiredCategoriesTool.authorize(ctxBearer("owner")),
    ).not.toThrow();
    try {
      hardDeleteExpiredCategoriesTool.authorize(ctxBearer("staff"));
      throw new Error("expected McpError");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
  });
});

describe("hardDeleteExpiredCategoriesTool — input schema", () => {
  it("rejects extra keys (.strict) and missing/false confirm", () => {
    expect(
      HardDeleteExpiredCategoriesMcpInputSchema.safeParse({
        confirm: true,
        tenantId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      HardDeleteExpiredCategoriesMcpInputSchema.safeParse({}).success,
    ).toBe(false);
    expect(
      HardDeleteExpiredCategoriesMcpInputSchema.safeParse({ confirm: false })
        .success,
    ).toBe(false);
    expect(
      HardDeleteExpiredCategoriesMcpInputSchema.safeParse({ confirm: true })
        .success,
    ).toBe(true);
  });

  it("requires confirm even when dryRun: true", () => {
    expect(
      HardDeleteExpiredCategoriesMcpInputSchema.safeParse({ dryRun: true })
        .success,
    ).toBe(false);
    expect(
      HardDeleteExpiredCategoriesMcpInputSchema.safeParse({
        dryRun: true,
        confirm: true,
      }).success,
    ).toBe(true);
  });
});

describe("hardDeleteExpiredCategoriesTool — output schema", () => {
  it("accepts dryRun shape and non-dryRun shape", () => {
    expect(
      HardDeleteExpiredCategoriesMcpOutputSchema.safeParse({
        count: 2,
        ids: [randomUUID(), randomUUID()],
        dryRun: true,
      }).success,
    ).toBe(true);
    expect(
      HardDeleteExpiredCategoriesMcpOutputSchema.safeParse({
        count: 1,
        ids: [randomUUID()],
        dryRun: false,
      }).success,
    ).toBe(true);
  });
});

describe("hardDeleteExpiredCategoriesTool — handler tripwires", () => {
  it("tx===null path throws McpError(internal_error)", async () => {
    const ctx = ctxBearer("owner");
    await expect(
      hardDeleteExpiredCategoriesTool.handler(
        ctx,
        { confirm: true, dryRun: true },
        null,
      ),
    ).rejects.toMatchObject({ kind: "internal_error" });
  });
});
