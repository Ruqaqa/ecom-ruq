/**
 * Composite audit-after assembler for `createProductRich`
 * (architect Block 2).
 *
 * Pure module. Wraps the existing `buildOptionsAuditAfterSnapshot` /
 * `buildVariantsAuditSnapshot` helpers and adds a small categories
 * `{ids, hash}` snapshot. Composes the parent audit `after` payload.
 * Localized text MUST NOT cross into the snapshot output (only ids and
 * hashes).
 */
import { describe, it, expect } from "vitest";
import {
  buildCategoriesAuditSnapshot,
  buildRichCreateAuditAfter,
} from "@/server/services/products/rich-create-audit";

describe("buildCategoriesAuditSnapshot", () => {
  it("returns sorted ids and a stable hash", () => {
    const productId = "11111111-1111-1111-1111-111111111111";
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const r1 = buildCategoriesAuditSnapshot({
      productId,
      categoryIds: [b, a],
    });
    const r2 = buildCategoriesAuditSnapshot({
      productId,
      categoryIds: [a, b],
    });
    expect(r1.ids).toEqual([a, b]);
    expect(r2.ids).toEqual([a, b]);
    expect(r1.hash).toBe(r2.hash);
    expect(r1.hash).toMatch(/^[a-f0-9]{32}$/);
  });

  it("returns empty for empty input", () => {
    const r = buildCategoriesAuditSnapshot({
      productId: "11111111-1111-1111-1111-111111111111",
      categoryIds: [],
    });
    expect(r.ids).toEqual([]);
    expect(r.hash).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe("buildRichCreateAuditAfter", () => {
  it("nulls every section when its input is empty/undefined", () => {
    const r = buildRichCreateAuditAfter({
      productId: "11111111-1111-1111-1111-111111111111",
    });
    expect(r.productId).toBe("11111111-1111-1111-1111-111111111111");
    expect(r.options).toBeNull();
    expect(r.variants).toBeNull();
    expect(r.categories).toBeNull();
  });

  it("composes options, variants, and categories snapshots when present", () => {
    const productId = "11111111-1111-1111-1111-111111111111";
    const optionId = "22222222-2222-2222-2222-222222222222";
    const valueId = "33333333-3333-3333-3333-333333333333";
    const variantId = "44444444-4444-4444-4444-444444444444";
    const cat1 = "55555555-5555-5555-5555-555555555555";

    const r = buildRichCreateAuditAfter({
      productId,
      options: [
        {
          id: optionId,
          position: 0,
          values: [{ id: valueId, position: 0 }],
        },
      ],
      variants: [
        {
          id: variantId,
          sku: "SKU-1",
          priceMinor: 1000,
          currency: "SAR",
          stock: 1,
          active: true,
          optionValueIds: [valueId],
        },
      ],
      categoryIds: [cat1],
    });

    expect(r.options).not.toBeNull();
    expect(r.options?.optionsCount).toBe(1);
    expect(r.options?.optionIds).toEqual([optionId]);
    // The greenfield-create cascade list is always empty.
    expect(r.options?.cascadedVariantIds).toEqual([]);

    expect(r.variants).not.toBeNull();
    expect(r.variants?.count).toBe(1);
    expect(r.variants?.ids).toEqual([variantId]);

    expect(r.categories).not.toBeNull();
    expect(r.categories?.ids).toEqual([cat1]);
  });

  it("snapshot output never contains localized text fields", () => {
    const r = buildRichCreateAuditAfter({
      productId: "11111111-1111-1111-1111-111111111111",
      options: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          position: 0,
          values: [
            {
              id: "33333333-3333-3333-3333-333333333333",
              position: 0,
            },
          ],
        },
      ],
      variants: [
        {
          id: "44444444-4444-4444-4444-444444444444",
          sku: "S",
          priceMinor: 1,
          currency: "SAR",
          stock: 1,
          active: true,
          optionValueIds: ["33333333-3333-3333-3333-333333333333"],
        },
      ],
      categoryIds: ["55555555-5555-5555-5555-555555555555"],
    });
    const json = JSON.stringify(r);
    // No localized JSONB keys ever cross into the audit chain.
    expect(json).not.toMatch(/"name"/);
    expect(json).not.toMatch(/"value":\s*\{/);
    expect(json).not.toMatch(/"description"/);
    // No SKU strings in the snapshot output (they go into the hash, not
    // the surface fields).
    expect(json).not.toContain("\"sku\":");
  });

  it("hash differs for different category sets", () => {
    const productId = "11111111-1111-1111-1111-111111111111";
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const r1 = buildCategoriesAuditSnapshot({ productId, categoryIds: [a] });
    const r2 = buildCategoriesAuditSnapshot({ productId, categoryIds: [a, b] });
    expect(r1.hash).not.toEqual(r2.hash);
  });
});

