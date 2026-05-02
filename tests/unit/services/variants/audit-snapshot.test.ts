/**
 * Audit-snapshot helpers for variants + options (chunk 1a.5.1, spec §7).
 *
 * The wire return for `setProductOptions` / `setProductVariants` carries
 * full materialised rows (the admin UI needs them). The append-only
 * audit chain receives a BOUNDED snapshot — count + ids + a
 * deterministic content-hash. Localized name/value JSONB does not cross
 * into audit (would expand the chain by ~16KB per option name and could
 * carry future buyer PII via mistranslated copy).
 */
import { describe, it, expect } from "vitest";
import {
  buildOptionsAuditSnapshot,
  buildOptionsAuditAfterSnapshot,
  buildVariantsAuditSnapshot,
  type OptionsAuditInput,
  type VariantsAuditInput,
} from "@/server/services/variants/audit-snapshot";

describe("buildOptionsAuditSnapshot", () => {
  it("captures productId, optionsCount, valuesCount, sorted ids", () => {
    const input: OptionsAuditInput = {
      productId: "11111111-1111-4111-8111-111111111111",
      options: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          position: 1,
          values: [
            { id: "22222222-2222-4222-8222-222222222222", position: 0 },
            { id: "11111111-2222-4222-8222-222222222222", position: 1 },
          ],
        },
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          position: 0,
          values: [
            { id: "33333333-3333-4333-8333-333333333333", position: 0 },
          ],
        },
      ],
    };

    const snapshot = buildOptionsAuditSnapshot(input);

    expect(snapshot.productId).toBe("11111111-1111-4111-8111-111111111111");
    expect(snapshot.optionsCount).toBe(2);
    expect(snapshot.valuesCount).toBe(3);
    expect(snapshot.optionIds).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    expect(snapshot.valueIds).toEqual([
      "11111111-2222-4222-8222-222222222222",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(snapshot.hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("hashes deterministically regardless of input order", () => {
    const ordered: OptionsAuditInput = {
      productId: "11111111-1111-4111-8111-111111111111",
      options: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          position: 0,
          values: [{ id: "33333333-3333-4333-8333-333333333333", position: 0 }],
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          position: 1,
          values: [
            { id: "11111111-2222-4222-8222-222222222222", position: 1 },
            { id: "22222222-2222-4222-8222-222222222222", position: 0 },
          ],
        },
      ],
    };
    const reordered: OptionsAuditInput = {
      productId: "11111111-1111-4111-8111-111111111111",
      options: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          position: 1,
          values: [
            { id: "22222222-2222-4222-8222-222222222222", position: 0 },
            { id: "11111111-2222-4222-8222-222222222222", position: 1 },
          ],
        },
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          position: 0,
          values: [{ id: "33333333-3333-4333-8333-333333333333", position: 0 }],
        },
      ],
    };

    expect(buildOptionsAuditSnapshot(ordered).hash).toBe(
      buildOptionsAuditSnapshot(reordered).hash,
    );
  });

  it("hash changes when an option position changes", () => {
    const a: OptionsAuditInput = {
      productId: "11111111-1111-4111-8111-111111111111",
      options: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          position: 0,
          values: [{ id: "33333333-3333-4333-8333-333333333333", position: 0 }],
        },
      ],
    };
    const b: OptionsAuditInput = {
      ...a,
      options: a.options.map((o) => ({ ...o, position: 1 })),
    };

    expect(buildOptionsAuditSnapshot(a).hash).not.toBe(
      buildOptionsAuditSnapshot(b).hash,
    );
  });

  it("contains no localized name fields (PDPL guard — name jsonb never crosses into audit)", () => {
    const snapshot = buildOptionsAuditSnapshot({
      productId: "11111111-1111-4111-8111-111111111111",
      options: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          position: 0,
          values: [{ id: "33333333-3333-4333-8333-333333333333", position: 0 }],
        },
      ],
    });
    const serialized = JSON.stringify(snapshot);
    // No "name" or "value" keys anywhere in the snapshot.
    expect(serialized).not.toMatch(/"name"/);
    expect(serialized).not.toMatch(/"value"/);
  });
});

describe("buildOptionsAuditAfterSnapshot (1a.5.3 cascade extension)", () => {
  const baseInput: OptionsAuditInput = {
    productId: "11111111-1111-4111-8111-111111111111",
    options: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 0,
        values: [{ id: "33333333-3333-4333-8333-333333333333", position: 0 }],
      },
    ],
  };

  it("attaches cascadedVariantIds (sorted) and matches the base shape otherwise", () => {
    const snap = buildOptionsAuditAfterSnapshot(baseInput, [
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    expect(snap.cascadedVariantIds).toEqual([
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ]);
    expect(snap.optionIds).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
    expect(snap.valueIds).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(snap.hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("hash differs between cascade-true and cascade-false (forensic distinguishability)", () => {
    const noCascade = buildOptionsAuditAfterSnapshot(baseInput, []);
    const withCascade = buildOptionsAuditAfterSnapshot(baseInput, [
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ]);
    expect(noCascade.hash).not.toBe(withCascade.hash);
  });

  it("hash is invariant under cascadedVariantIds input ordering", () => {
    const a = buildOptionsAuditAfterSnapshot(baseInput, [
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    const b = buildOptionsAuditAfterSnapshot(baseInput, [
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ]);
    expect(a.hash).toBe(b.hash);
  });

  it("contains no localized text or SKUs (PDPL guard preserved on extension)", () => {
    const snap = buildOptionsAuditAfterSnapshot(baseInput, [
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ]);
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toMatch(/"name"/);
    expect(serialized).not.toMatch(/"sku"/);
    // The single jsonb-shaped key allowed in the snapshot is
    // `cascadedVariantIds`. The literal token `"value"` (a JSONB
    // localized key) must NOT appear.
    expect(serialized).not.toMatch(/"value":/);
  });
});

describe("buildVariantsAuditSnapshot", () => {
  it("captures productId, count, sorted ids, hash (no skuHash, no SKU strings)", () => {
    const input: VariantsAuditInput = {
      productId: "11111111-1111-4111-8111-111111111111",
      variants: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          sku: "SKU-Z",
          priceMinor: 1000,
          currency: "SAR",
          stock: 5,
          active: true,
          optionValueIds: ["x", "y"],
        },
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sku: "SKU-A",
          priceMinor: 2000,
          currency: "SAR",
          stock: 0,
          active: false,
          optionValueIds: ["x", "z"],
        },
      ],
    };

    const snapshot = buildVariantsAuditSnapshot(input);

    expect(snapshot.productId).toBe("11111111-1111-4111-8111-111111111111");
    expect(snapshot.count).toBe(2);
    expect(snapshot.ids).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    // 32 hex chars / 128 bits — forensic-correlation safety knob.
    expect(snapshot.hash).toMatch(/^[0-9a-f]{32}$/);
    // Spec §7 explicitly drops `skuHash`. Snapshot key set is locked.
    expect(Object.keys(snapshot).sort()).toEqual(
      ["count", "hash", "ids", "productId"],
    );
  });

  it("hash is deterministic regardless of input order", () => {
    const a: VariantsAuditInput = {
      productId: "11111111-1111-4111-8111-111111111111",
      variants: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sku: "SKU-A",
          priceMinor: 100,
          currency: "SAR",
          stock: 0,
          active: true,
          optionValueIds: [],
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          sku: "SKU-B",
          priceMinor: 200,
          currency: "SAR",
          stock: 0,
          active: true,
          optionValueIds: [],
        },
      ],
    };
    const b: VariantsAuditInput = {
      productId: "11111111-1111-4111-8111-111111111111",
      variants: [a.variants[1]!, a.variants[0]!],
    };

    expect(buildVariantsAuditSnapshot(a).hash).toBe(
      buildVariantsAuditSnapshot(b).hash,
    );
  });

  it("hash changes when priceMinor changes (full-content change-detector)", () => {
    const a: VariantsAuditInput = {
      productId: "11111111-1111-4111-8111-111111111111",
      variants: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sku: "SKU-A",
          priceMinor: 100,
          currency: "SAR",
          stock: 0,
          active: true,
          optionValueIds: [],
        },
      ],
    };
    const b: VariantsAuditInput = {
      ...a,
      variants: [{ ...a.variants[0]!, priceMinor: 200 }],
    };

    expect(buildVariantsAuditSnapshot(a).hash).not.toBe(
      buildVariantsAuditSnapshot(b).hash,
    );
  });

  it("hash changes when SKU changes (SKU is in the hash payload even though the snapshot drops the SKU strings)", () => {
    const a: VariantsAuditInput = {
      productId: "11111111-1111-4111-8111-111111111111",
      variants: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sku: "SKU-A",
          priceMinor: 100,
          currency: "SAR",
          stock: 0,
          active: true,
          optionValueIds: [],
        },
      ],
    };
    const b: VariantsAuditInput = {
      ...a,
      variants: [{ ...a.variants[0]!, sku: "SKU-B" }],
    };

    expect(buildVariantsAuditSnapshot(a).hash).not.toBe(
      buildVariantsAuditSnapshot(b).hash,
    );
  });

  it("snapshot does NOT contain the full SKU strings (only the hash)", () => {
    const snapshot = buildVariantsAuditSnapshot({
      productId: "p",
      variants: [
        {
          id: "id1",
          sku: "TOPSECRET-SKU-12345",
          priceMinor: 100,
          currency: "SAR",
          stock: 0,
          active: true,
          optionValueIds: [],
        },
      ],
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("TOPSECRET");
    expect(serialized).not.toContain("SKU-12345");
  });
});
