/**
 * Pure-helper unit tests for the variants admin UX (chunk 1a.5.2).
 *
 * The form's variant table is a derived view of the option-types tree:
 *   options × values → cartesian product → rows keyed by tuple.
 *
 * Two correctness invariants are tested here as pure logic, isolated
 * from React, DOM, network, and the tRPC wire shape:
 *
 *   1. `buildVariantRows(options, currentVariants)` materialises the
 *      cartesian product of option-value-ids in option-position order,
 *      generates a deterministic `data-key` per tuple, and merges any
 *      currently-persisted variant row by tuple-equality so SKU /
 *      price / stock / id survive a re-open of the form.
 *
 *   2. `formatCombinationLabel(tuple, options, locale)` joins the
 *      option-name : value-name pairs in option-position order with
 *      ` · ` (LTR) — the result is the row's visible label and is also
 *      used as the row's `aria-label` (the Screen 2 truncation
 *      contract).
 *
 * Both pieces are pure. They drive the visible UI, but they do not
 * own state, and they do not call the server. We test them in
 * isolation so the Playwright spec only needs to assert end-to-end
 * behaviour, not generator details.
 *
 * Both files are intentionally NOT yet implemented at the time these
 * tests are written — TDD red phase.
 */
import { describe, it, expect } from "vitest";
import {
  buildVariantRows,
  formatCombinationLabel,
  variantRowKey,
  type EditorOption,
  type EditorVariant,
} from "@/lib/variants/build-variant-rows";

function opt(
  id: string,
  nameEn: string,
  position: number,
  values: Array<{ id: string; en: string; position: number }>,
): EditorOption {
  return {
    id,
    name: { en: nameEn, ar: nameEn },
    position,
    values: values.map((v) => ({
      id: v.id,
      value: { en: v.en, ar: v.en },
      position: v.position,
    })),
  };
}

describe("variantRowKey", () => {
  it('returns "default" for the empty tuple', () => {
    expect(variantRowKey([])).toBe("default");
  });

  it("joins ids sorted lexically with `:` so two orderings collide", () => {
    const a = "00000000-0000-0000-0000-00000000000a";
    const b = "00000000-0000-0000-0000-00000000000b";
    const c = "00000000-0000-0000-0000-00000000000c";
    expect(variantRowKey([b, a, c])).toBe(variantRowKey([c, a, b]));
    expect(variantRowKey([a, b, c])).toBe(`${a}:${b}:${c}`);
  });
});

describe("buildVariantRows — cartesian generator", () => {
  it("returns one default row when there are no options", () => {
    const rows = buildVariantRows([], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tuple).toEqual([]);
    expect(rows[0]!.key).toBe("default");
  });

  it("returns N rows for one option with N values, in option-value-position order", () => {
    const options = [
      opt("opt-1", "Colour", 1, [
        { id: "v-black", en: "Black", position: 1 },
        { id: "v-white", en: "White", position: 2 },
      ]),
    ];
    const rows = buildVariantRows(options, []);
    expect(rows.map((r) => r.tuple)).toEqual([["v-black"], ["v-white"]]);
  });

  it("emits the cartesian product of two options in option-position order", () => {
    const options = [
      opt("opt-1", "Colour", 1, [
        { id: "v-black", en: "Black", position: 1 },
        { id: "v-white", en: "White", position: 2 },
      ]),
      opt("opt-2", "Size", 2, [
        { id: "v-s", en: "S", position: 1 },
        { id: "v-m", en: "M", position: 2 },
      ]),
    ];
    const rows = buildVariantRows(options, []);
    expect(rows.map((r) => r.tuple)).toEqual([
      ["v-black", "v-s"],
      ["v-black", "v-m"],
      ["v-white", "v-s"],
      ["v-white", "v-m"],
    ]);
  });

  it("merges existing variant rows by tuple-equality so SKU/price/stock/id survive re-open", () => {
    const options = [
      opt("opt-1", "Colour", 1, [
        { id: "v-black", en: "Black", position: 1 },
        { id: "v-white", en: "White", position: 2 },
      ]),
    ];
    const existing: EditorVariant[] = [
      {
        id: "var-1",
        sku: "AV-CAM-BLK",
        priceMinor: 125000,
        currency: "SAR",
        stock: 12,
        active: true,
        optionValueIds: ["v-black"],
      },
    ];
    const rows = buildVariantRows(options, existing);
    expect(rows).toHaveLength(2);
    const blackRow = rows.find((r) => r.tuple[0] === "v-black")!;
    const whiteRow = rows.find((r) => r.tuple[0] === "v-white")!;
    expect(blackRow.id).toBe("var-1");
    expect(blackRow.sku).toBe("AV-CAM-BLK");
    expect(blackRow.priceMinor).toBe(125000);
    expect(blackRow.stock).toBe(12);
    // Brand-new tuple: id is undefined; SKU and price/stock default empty.
    expect(whiteRow.id).toBeUndefined();
    expect(whiteRow.sku).toBe("");
    expect(whiteRow.priceMinor).toBeNull();
    expect(whiteRow.stock).toBeNull();
  });

  it("when no options are defined and an existing variant exists, the default row inherits its values", () => {
    const existing: EditorVariant[] = [
      {
        id: "var-1",
        sku: "AV-CAM",
        priceMinor: 99900,
        currency: "SAR",
        stock: 5,
        active: true,
        optionValueIds: [],
      },
    ];
    const rows = buildVariantRows([], existing);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("var-1");
    expect(rows[0]!.sku).toBe("AV-CAM");
    expect(rows[0]!.priceMinor).toBe(99900);
    expect(rows[0]!.stock).toBe(5);
  });

  it("orders values by position within each option, not by id or insertion", () => {
    // Insertion order: M before S. Position says S(1) before M(2).
    const options = [
      opt("opt-1", "Size", 1, [
        { id: "v-m", en: "M", position: 2 },
        { id: "v-s", en: "S", position: 1 },
      ]),
    ];
    const rows = buildVariantRows(options, []);
    expect(rows.map((r) => r.tuple)).toEqual([["v-s"], ["v-m"]]);
  });
});

/**
 * State-C collapse / expand preservation (chunk 1a.5.3).
 *
 * The cartesian generator gains an optional `transitionMergePolicy`
 * argument that controls what hydrates the default row when the operator
 * removes their last option type, and what hydrates the first generated
 * row when the operator adds the first option type to a previously-flat
 * product.
 *
 * The default policy ("strict") preserves the 1a.5.2 contract — only
 * tuple-equality merges. The "preserve-first-touched" policy is opted
 * into by the form on Save when it detects an in-progress State-C
 * transition; it picks the first existing row (any tuple) whose SKU /
 * price / stock has been touched and uses that as the seed for the
 * collapsed default row, OR the first generated row when expanding.
 */
describe("buildVariantRows — State-C transition preservation (1a.5.3)", () => {
  const colour = opt("opt-1", "Colour", 1, [
    { id: "v-black", en: "Black", position: 1 },
    { id: "v-white", en: "White", position: 2 },
  ]);

  it("collapse-from-multi: preserves first-touched row's SKU/price/stock as the default", () => {
    // Before collapse the operator has two rows; only the Black row is
    // touched. After removing the last option type, the default row
    // should inherit the Black row's data.
    const touched: EditorVariant[] = [
      {
        sku: "AV-CAM-BLK",
        priceMinor: 125000,
        currency: "SAR",
        stock: 12,
        active: true,
        optionValueIds: ["v-black"],
      },
      {
        sku: "",
        priceMinor: 0,
        currency: "SAR",
        stock: 0,
        active: true,
        optionValueIds: ["v-white"],
      },
    ];
    const rows = buildVariantRows([], touched, {
      transitionMergePolicy: "preserve-first-touched",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("default");
    expect(rows[0]!.sku).toBe("AV-CAM-BLK");
    expect(rows[0]!.priceMinor).toBe(125000);
    expect(rows[0]!.stock).toBe(12);
  });

  it("collapse-from-multi with no touched rows yields an empty default", () => {
    const untouched: EditorVariant[] = [
      {
        sku: "",
        priceMinor: 0,
        currency: "SAR",
        stock: 0,
        active: true,
        optionValueIds: ["v-black"],
      },
    ];
    const rows = buildVariantRows([], untouched, {
      transitionMergePolicy: "preserve-first-touched",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("default");
    expect(rows[0]!.sku).toBe("");
    expect(rows[0]!.priceMinor).toBeNull();
    expect(rows[0]!.stock).toBeNull();
  });

  it("collapse: the existing default-tuple row wins over an arbitrary touched non-default row", () => {
    // If the operator already has a persisted default-tuple row in the
    // mix (e.g. an earlier life of the product was single-variant), it
    // takes priority over preserve-first-touched.
    const mixed: EditorVariant[] = [
      {
        sku: "TOUCHED-NON-DEFAULT",
        priceMinor: 50000,
        currency: "SAR",
        stock: 5,
        active: true,
        optionValueIds: ["v-black"],
      },
      {
        id: "var-default",
        sku: "PERSISTED-DEFAULT",
        priceMinor: 99900,
        currency: "SAR",
        stock: 2,
        active: true,
        optionValueIds: [],
      },
    ];
    const rows = buildVariantRows([], mixed, {
      transitionMergePolicy: "preserve-first-touched",
    });
    expect(rows[0]!.sku).toBe("PERSISTED-DEFAULT");
    expect(rows[0]!.id).toBe("var-default");
  });

  it("expand-from-flat: flat-form data carries into the FIRST generated row (preserve-first-touched)", () => {
    // The operator has been editing the flat-form (default-tuple) and
    // typed SKU/price/stock. Now they add a Colour option with two
    // values. The first generated row (Black) should pick up the
    // flat-form data; White is an untouched fresh row.
    const flatForm: EditorVariant[] = [
      {
        sku: "AV-CAM",
        priceMinor: 99900,
        currency: "SAR",
        stock: 5,
        active: true,
        optionValueIds: [],
      },
    ];
    const rows = buildVariantRows([colour], flatForm, {
      transitionMergePolicy: "preserve-first-touched",
    });
    expect(rows).toHaveLength(2);
    const blackRow = rows.find((r) => r.tuple[0] === "v-black")!;
    const whiteRow = rows.find((r) => r.tuple[0] === "v-white")!;
    expect(blackRow.sku).toBe("AV-CAM");
    expect(blackRow.priceMinor).toBe(99900);
    expect(blackRow.stock).toBe(5);
    expect(whiteRow.sku).toBe("");
    expect(whiteRow.priceMinor).toBeNull();
    expect(whiteRow.stock).toBeNull();
  });

  it("expand-from-flat with empty flat-form keeps all generated rows empty", () => {
    const rows = buildVariantRows([colour], [], {
      transitionMergePolicy: "preserve-first-touched",
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.sku).toBe("");
      expect(r.priceMinor).toBeNull();
      expect(r.stock).toBeNull();
    }
  });

  it("default policy (strict) leaves default row empty when no default-tuple exists in input", () => {
    // No transitionMergePolicy passed — must behave exactly as 1a.5.2.
    const touched: EditorVariant[] = [
      {
        sku: "AV-CAM-BLK",
        priceMinor: 125000,
        currency: "SAR",
        stock: 12,
        active: true,
        optionValueIds: ["v-black"],
      },
    ];
    const rows = buildVariantRows([], touched);
    expect(rows[0]!.sku).toBe("");
    expect(rows[0]!.priceMinor).toBeNull();
    expect(rows[0]!.stock).toBeNull();
  });

  it("value-removal (not option-removal) preserves all surviving rows by tuple-equality", () => {
    // Operator removes the White value. The remaining options still has
    // Colour with one value (Black). The Black tuple's SKU/price/stock
    // survives; nothing about White is preserved (it was the only
    // touched row that lost its anchor).
    const colourBlackOnly = opt("opt-1", "Colour", 1, [
      { id: "v-black", en: "Black", position: 1 },
    ]);
    const before: EditorVariant[] = [
      {
        sku: "AV-CAM-BLK",
        priceMinor: 125000,
        currency: "SAR",
        stock: 12,
        active: true,
        optionValueIds: ["v-black"],
      },
      {
        sku: "AV-CAM-WHT",
        priceMinor: 125000,
        currency: "SAR",
        stock: 8,
        active: true,
        optionValueIds: ["v-white"],
      },
    ];
    const rows = buildVariantRows([colourBlackOnly], before);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tuple).toEqual(["v-black"]);
    expect(rows[0]!.sku).toBe("AV-CAM-BLK");
  });
});

describe("formatCombinationLabel", () => {
  const options = [
    opt("opt-1", "Colour", 1, [
      { id: "v-black", en: "Black", position: 1 },
      { id: "v-white", en: "White", position: 2 },
    ]),
    opt("opt-2", "Size", 2, [
      { id: "v-s", en: "S", position: 1 },
      { id: "v-m", en: "M", position: 2 },
    ]),
  ];

  it("joins option:value pairs in option-position order with ` · `", () => {
    expect(formatCombinationLabel(["v-black", "v-m"], options, "en")).toBe(
      "Colour: Black · Size: M",
    );
  });

  it("respects locale on both option and value names", () => {
    const arOptions = [
      {
        ...options[0]!,
        name: { en: "Colour", ar: "اللون" },
        values: [
          { id: "v-black", value: { en: "Black", ar: "أسود" }, position: 1 },
          { id: "v-white", value: { en: "White", ar: "أبيض" }, position: 2 },
        ],
      },
    ];
    expect(formatCombinationLabel(["v-black"], arOptions, "ar")).toBe(
      "اللون: أسود",
    );
  });

  it("returns an empty string for the default tuple (no options)", () => {
    expect(formatCombinationLabel([], [], "en")).toBe("");
  });
});
