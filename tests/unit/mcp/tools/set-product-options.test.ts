/**
 * `set_product_options` MCP tool — unit tests for tool shape in isolation
 * (1a.5.1 + 1a.5.3 amendment).
 *
 * Description string-equality is asserted verbatim against the security
 * spec §7 copy. A future refactor that quietly weakens the cascade
 * contract for autonomous agents fails this test.
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

const EXPECTED_DESCRIPTION =
  "This tool replaces the entire set on the product. It is not a " +
  "patch. Read the rules below before calling. " +
  "Set the option types and their values on a product (SET-REPLACE, " +
  "NOT a patch). The provided list REPLACES the existing options/values " +
  "for this product. To rename or reorder an existing option type or " +
  "value without deleting it, include its existing id in the input with " +
  "the new fields. To add a new option type or value, omit the id field " +
  "— the server mints one. " +
  "An option type present today but missing from the input is REMOVED " +
  "from the product; ALL VARIANT ROWS that reference any value of that " +
  "option type are HARD-DELETED in the same call. Variant rows do not " +
  "have a recovery window — the parent product's soft-delete is the " +
  "broader recovery net. Removing an option value (keeping the option " +
  "type) is similarly a removal: every variant referencing that value " +
  "is hard-deleted. There is no preview; if you are unsure, list the " +
  "product's current variants first via getProductWithVariants. " +
  "Caps: at most 3 option types per product, at most 100 values per " +
  "option. Owner or staff. Optimistic concurrency on the product's " +
  "expectedUpdatedAt.";

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
  it("description matches the security §7 copy verbatim — guards against silent contract weakening", () => {
    // String-equality check protects future refactors from quietly
    // weakening the cascade-on-omission contract that autonomous agents
    // see on tools/list. If you intentionally change the wording,
    // update both the tool source and this expected string in the
    // same PR (with security review for any change to "cascade",
    // "HARD-DELETED", or "recovery window" wording).
    expect(setProductOptionsTool.description).toBe(EXPECTED_DESCRIPTION);
  });

  it("description names the cascade contract explicitly (cannot be removed)", () => {
    // Belt-and-braces canary: the verbatim test above is exact, but
    // these substring assertions target the load-bearing words a
    // partial-rewrite would still need to keep.
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
