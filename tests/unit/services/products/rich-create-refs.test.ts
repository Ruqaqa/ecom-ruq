/**
 * Local-ref helper for `createProductRich` (architect Block 1).
 *
 * Pure module, no DB. Validates ref-shape invariants and resolves the
 * agent-supplied `<optionRef>:<valueRef>` strings on each variant into
 * the UUID-shaped `optionValueIds` arrays the existing setProductVariants
 * service expects.
 *
 * Refs are call-scoped, never persisted. They exist only inside one
 * request's input.
 */
import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import {
  CreateProductRichInputSchema,
  buildRefMaps,
  resolveRichVariants,
} from "@/server/services/products/rich-create-refs";

describe("rich-create refs — Zod shape invariants", () => {
  it("accepts a fully valid input", () => {
    const r = CreateProductRichInputSchema.safeParse({
      slug: "shirt",
      name: { en: "Shirt", ar: "قميص" },
      options: [
        {
          ref: "size",
          name: { en: "Size", ar: "المقاس" },
          values: [
            { ref: "small", value: { en: "S", ar: "صغير" } },
            { ref: "large", value: { en: "L", ar: "كبير" } },
          ],
        },
      ],
      variants: [
        {
          sku: "SH-S",
          priceSar: 50,
          stock: 5,
          optionValueRefs: ["size:small"],
        },
        {
          sku: "SH-L",
          priceSar: 50,
          stock: 5,
          optionValueRefs: ["size:large"],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects duplicate option refs at path options[i].ref", () => {
    const r = CreateProductRichInputSchema.safeParse({
      slug: "x",
      name: { en: "X", ar: "س" },
      options: [
        {
          ref: "size",
          name: { en: "Size", ar: "ا" },
          values: [{ ref: "s", value: { en: "S", ar: "ص" } }],
        },
        {
          ref: "size",
          name: { en: "Size2", ar: "ا" },
          values: [{ ref: "s", value: { en: "S", ar: "ص" } }],
        },
      ],
      variants: [],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issues = (r.error as ZodError).issues;
      const dup = issues.find((i) => i.message === "option_ref_duplicate");
      expect(dup).toBeTruthy();
      expect(dup?.path[0]).toBe("options");
    }
  });

  it("rejects duplicate value refs within one option at options[i].values[j].ref", () => {
    const r = CreateProductRichInputSchema.safeParse({
      slug: "x",
      name: { en: "X", ar: "س" },
      options: [
        {
          ref: "size",
          name: { en: "Size", ar: "ا" },
          values: [
            { ref: "s", value: { en: "S", ar: "ص" } },
            { ref: "s", value: { en: "M", ar: "م" } },
          ],
        },
      ],
      variants: [],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const dup = r.error.issues.find(
        (i) => i.message === "option_value_ref_duplicate",
      );
      expect(dup).toBeTruthy();
    }
  });

  it("rejects variant.optionValueRefs.length != options.length (pathed)", () => {
    const r = CreateProductRichInputSchema.safeParse({
      slug: "x",
      name: { en: "X", ar: "س" },
      options: [
        {
          ref: "size",
          name: { en: "Size", ar: "ا" },
          values: [{ ref: "s", value: { en: "S", ar: "ص" } }],
        },
        {
          ref: "color",
          name: { en: "Color", ar: "ل" },
          values: [{ ref: "red", value: { en: "R", ar: "ر" } }],
        },
      ],
      variants: [
        {
          sku: "X-1",
          priceSar: 1,
          stock: 1,
          optionValueRefs: ["size:s"], // length 1; options.length is 2
        },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(
        (i) => i.message === "variant_option_value_refs_length_mismatch",
      );
      expect(issue).toBeTruthy();
      expect(issue?.path).toEqual(["variants", 0, "optionValueRefs"]);
    }
  });

  it("rejects an unknown value ref at variants[i].optionValueRefs[j]", () => {
    const r = CreateProductRichInputSchema.safeParse({
      slug: "x",
      name: { en: "X", ar: "س" },
      options: [
        {
          ref: "size",
          name: { en: "Size", ar: "ا" },
          values: [{ ref: "s", value: { en: "S", ar: "ص" } }],
        },
      ],
      variants: [
        {
          sku: "X-1",
          priceSar: 1,
          stock: 1,
          optionValueRefs: ["size:nope"], // unknown value ref under "size"
        },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(
        (i) => i.message === "option_value_ref_unknown",
      );
      expect(issue).toBeTruthy();
      expect(issue?.path).toEqual(["variants", 0, "optionValueRefs", 0]);
    }
  });

  it("rejects a ref to the wrong option at this position", () => {
    // Position 0 expects refs under options[0] = size; "color:red" points at options[1]
    const r = CreateProductRichInputSchema.safeParse({
      slug: "x",
      name: { en: "X", ar: "س" },
      options: [
        {
          ref: "size",
          name: { en: "Size", ar: "ا" },
          values: [{ ref: "s", value: { en: "S", ar: "ص" } }],
        },
        {
          ref: "color",
          name: { en: "Color", ar: "ل" },
          values: [{ ref: "red", value: { en: "R", ar: "ر" } }],
        },
      ],
      variants: [
        {
          sku: "X-1",
          priceSar: 1,
          stock: 1,
          optionValueRefs: ["color:red", "size:s"], // wrong order
        },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(
        (i) =>
          i.message === "option_value_ref_wrong_option" ||
          i.message === "option_value_ref_unknown",
      );
      expect(issue).toBeTruthy();
    }
  });

  it("rejects two variants with the same resolved tuple", () => {
    const r = CreateProductRichInputSchema.safeParse({
      slug: "x",
      name: { en: "X", ar: "س" },
      options: [
        {
          ref: "size",
          name: { en: "Size", ar: "ا" },
          values: [{ ref: "s", value: { en: "S", ar: "ص" } }],
        },
      ],
      variants: [
        { sku: "A", priceSar: 1, stock: 1, optionValueRefs: ["size:s"] },
        { sku: "B", priceSar: 1, stock: 1, optionValueRefs: ["size:s"] },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(
        (i) => i.message === "duplicate_variant_combination",
      );
      expect(issue).toBeTruthy();
    }
  });

  it("rejects > 1 empty-tuple variants when options.length === 0", () => {
    const r = CreateProductRichInputSchema.safeParse({
      slug: "x",
      name: { en: "X", ar: "س" },
      options: [],
      variants: [
        { sku: "A", priceSar: 1, stock: 1, optionValueRefs: [] },
        { sku: "B", priceSar: 1, stock: 1, optionValueRefs: [] },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(
        (i) => i.message === "default_variant_required",
      );
      expect(issue).toBeTruthy();
    }
  });

  it("accepts a single empty-tuple variant when options.length === 0", () => {
    const r = CreateProductRichInputSchema.safeParse({
      slug: "x",
      name: { en: "X", ar: "س" },
      options: [],
      variants: [{ sku: "A", priceSar: 1, stock: 1, optionValueRefs: [] }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown extra keys at the top level (.strict)", () => {
    const r = CreateProductRichInputSchema.safeParse({
      slug: "x",
      name: { en: "X", ar: "س" },
      tenantId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.success).toBe(false);
  });
});

describe("resolveRichVariants", () => {
  it("converts ref tuples to uuid tuples in the same order as input options", () => {
    const sizeOptionId = "11111111-1111-1111-1111-111111111111";
    const colorOptionId = "22222222-2222-2222-2222-222222222222";
    const sId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const lId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const redId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const blueId = "dddddddd-dddd-dddd-dddd-dddddddddddd";

    const input = {
      slug: "x",
      name: { en: "X", ar: "س" },
      options: [
        {
          ref: "size",
          name: { en: "Size", ar: "ا" },
          values: [
            { ref: "s", value: { en: "S", ar: "ص" } },
            { ref: "l", value: { en: "L", ar: "ك" } },
          ],
        },
        {
          ref: "color",
          name: { en: "Color", ar: "ل" },
          values: [
            { ref: "red", value: { en: "R", ar: "ر" } },
            { ref: "blue", value: { en: "B", ar: "ز" } },
          ],
        },
      ],
      variants: [
        {
          sku: "X-1",
          priceSar: 100,
          stock: 1,
          optionValueRefs: ["size:s", "color:red"],
        },
        {
          sku: "X-2",
          priceSar: 200.5,
          stock: 2,
          optionValueRefs: ["size:l", "color:blue"],
          active: false,
          currency: "USD",
        },
      ],
    };
    const parsed = CreateProductRichInputSchema.parse(input);

    const optionsResult = [
      {
        id: sizeOptionId,
        name: { en: "Size", ar: "ا" },
        position: 0,
        values: [
          { id: sId, value: { en: "S", ar: "ص" }, position: 0 },
          { id: lId, value: { en: "L", ar: "ك" }, position: 1 },
        ],
      },
      {
        id: colorOptionId,
        name: { en: "Color", ar: "ل" },
        position: 1,
        values: [
          { id: redId, value: { en: "R", ar: "ر" }, position: 0 },
          { id: blueId, value: { en: "B", ar: "ز" }, position: 1 },
        ],
      },
    ];

    const out = resolveRichVariants(parsed, buildRefMaps(parsed, optionsResult));
    expect(out).toHaveLength(2);
    expect(out[0]?.optionValueIds).toEqual([sId, redId]);
    expect(out[1]?.optionValueIds).toEqual([lId, blueId]);
    // priceSar -> priceMinor halalas (200.50 SAR -> 20050 halalas).
    expect(out[1]?.priceMinor).toBe(20050);
    expect(out[0]?.priceMinor).toBe(10000);
    expect(out[1]?.active).toBe(false);
    expect(out[0]?.active).toBe(true); // default
    expect(out[1]?.currency).toBe("USD");
    expect(out[0]?.currency).toBe("SAR"); // default
  });

});
