/**
 * `hard_delete_expired_products` MCP tool — unit shape tests. Owner-only
 * (tighter than write-role). Schema must require confirm even with
 * dryRun.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  hardDeleteExpiredProductsTool,
  HardDeleteExpiredProductsMcpInputSchema,
  HardDeleteExpiredProductsMcpOutputSchema,
} from "@/server/mcp/tools/hard-delete-expired-products";
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
      scopes: { role, tools: ["hard_delete_expired_products"] },
    },
    correlationId: "cid-1",
    auditOverride: {},
  };
}

describe("hardDeleteExpiredProductsTool — visibility/authorize (owner-only)", () => {
  it("owner is the only role that sees and can call this tool", () => {
    expect(hardDeleteExpiredProductsTool.isVisibleFor(ctxBearer("owner"))).toBe(
      true,
    );
    expect(hardDeleteExpiredProductsTool.isVisibleFor(ctxBearer("staff"))).toBe(
      false,
    );
    expect(
      hardDeleteExpiredProductsTool.isVisibleFor(ctxBearer("support")),
    ).toBe(false);

    expect(() =>
      hardDeleteExpiredProductsTool.authorize(ctxBearer("owner")),
    ).not.toThrow();
    try {
      hardDeleteExpiredProductsTool.authorize(ctxBearer("staff"));
      throw new Error("expected McpError");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
  });
});

describe("hardDeleteExpiredProductsTool — input schema", () => {
  it("rejects extra keys (.strict) and missing/false confirm", () => {
    expect(
      HardDeleteExpiredProductsMcpInputSchema.safeParse({
        confirm: true,
        tenantId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      HardDeleteExpiredProductsMcpInputSchema.safeParse({}).success,
    ).toBe(false);
    expect(
      HardDeleteExpiredProductsMcpInputSchema.safeParse({ confirm: false })
        .success,
    ).toBe(false);
    expect(
      HardDeleteExpiredProductsMcpInputSchema.safeParse({ confirm: true })
        .success,
    ).toBe(true);
  });

  it("requires confirm even when dryRun: true", () => {
    expect(
      HardDeleteExpiredProductsMcpInputSchema.safeParse({ dryRun: true }).success,
    ).toBe(false);
    expect(
      HardDeleteExpiredProductsMcpInputSchema.safeParse({
        dryRun: true,
        confirm: true,
      }).success,
    ).toBe(true);
  });
});

describe("hardDeleteExpiredProductsTool — output schema", () => {
  it("accepts dryRun shape with slugs; non-dryRun shape without slugs", () => {
    expect(
      HardDeleteExpiredProductsMcpOutputSchema.safeParse({
        count: 2,
        ids: [randomUUID(), randomUUID()],
        slugs: ["a", "b"],
        dryRun: true,
      }).success,
    ).toBe(true);
    expect(
      HardDeleteExpiredProductsMcpOutputSchema.safeParse({
        count: 1,
        ids: [randomUUID()],
        dryRun: false,
      }).success,
    ).toBe(true);
  });
});

describe("hardDeleteExpiredProductsTool — handler tripwires", () => {
  it("tx===null path throws McpError(internal_error)", async () => {
    const ctx = ctxBearer("owner");
    await expect(
      hardDeleteExpiredProductsTool.handler(
        ctx,
        { confirm: true, dryRun: true },
        null,
      ),
    ).rejects.toMatchObject({ kind: "internal_error" });
  });
});
