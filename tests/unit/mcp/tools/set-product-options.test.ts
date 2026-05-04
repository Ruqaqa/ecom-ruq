/**
 * `set_product_options` MCP tool — unit tests for tool shape in isolation
 * (1a.5.1 + 1a.5.3 amendment).
 *
 * Description load-bearing-words guard: the substring assertions below
 * pin the cascade contract that autonomous agents read on tools/list. A
 * partial-rewrite that drops "HARD-DELETED" / "recovery window" /
 * "cascade|REMOVED" / "getProductWithVariants" fails the test. We do
 * NOT lock the description verbatim — that's a string-equals-itself test.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  setProductOptionsTool,
  SetProductOptionsMcpInputSchema,
} from "@/server/mcp/tools/set-product-options";
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
      scopes: { role, tools: ["set_product_options"] },
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

describe("setProductOptionsTool — visibility + authorize", () => {
  it("visible for owner / staff; hidden for support / anon", () => {
    expect(setProductOptionsTool.isVisibleFor(ctxBearer("owner"))).toBe(true);
    expect(setProductOptionsTool.isVisibleFor(ctxBearer("staff"))).toBe(true);
    expect(setProductOptionsTool.isVisibleFor(ctxBearer("support"))).toBe(
      false,
    );
    expect(setProductOptionsTool.isVisibleFor(ctxAnon)).toBe(false);
  });

  it("authorize rejects support / anon with closed-set kinds", () => {
    try {
      setProductOptionsTool.authorize(ctxBearer("support"));
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("forbidden");
    }
    try {
      setProductOptionsTool.authorize(ctxAnon);
      throw new Error("expected");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).kind).toBe("unauthorized");
    }
  });
});

describe("setProductOptionsTool — input schema .strict()", () => {
  it("rejects an extra key (tenantId is never user-supplied)", () => {
    expect(
      SetProductOptionsMcpInputSchema.safeParse({
        productId: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        options: [],
        tenantId: randomUUID(),
      }).success,
    ).toBe(false);
  });
});

describe("setProductOptionsTool — description (1a.5.3 cascade contract for autonomous agents)", () => {
  it("description names the cascade contract explicitly (cannot be removed)", () => {
    // The load-bearing words an AI agent reads on tools/list. A
    // partial-rewrite that drops any of these silently weakens the
    // cascade-on-omission contract.
    const desc = setProductOptionsTool.description;
    expect(desc).toMatch(/HARD-DELETED/);
    expect(desc).toMatch(/cascade|REMOVED/i);
    expect(desc).toMatch(/recovery window/);
    expect(desc).toMatch(/getProductWithVariants/);
  });

  it("description does NOT advertise the lifted 1a.5.1 transitional refusal", () => {
    // Prevents a stale spec snippet leaking back in.
    expect(setProductOptionsTool.description).not.toMatch(
      /option_remove_not_supported_yet/,
    );
  });
});
