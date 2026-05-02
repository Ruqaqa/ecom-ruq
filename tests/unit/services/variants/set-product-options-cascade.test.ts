/**
 * `setProductOptions` cascade-on-removal — chunk 1a.5.3.
 *
 * 1a.5.1 transitionally REFUSED removal of an existing option type or
 * value (`option_remove_not_supported_yet`). 1a.5.3 lifts that refusal
 * and wires the cascade flow live: omitting an option type from the
 * input HARD-DELETES every variant row whose `option_value_ids` JSONB
 * tuple references any value of that option, in the same tx, before
 * the option-type row is dropped. Variants do NOT have a recovery
 * window — the parent product's soft-delete is the broader recovery
 * net (prd §3.3).
 *
 * Spec references:
 *   - architect §1 (cascade contract end-to-end, single-tx + advisory-lock)
 *   - security §2 (cascadedVariantIds bounded, in-hash, ids-only)
 *   - security §9 (test surface)
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const superClient = postgres(DATABASE_URL, { max: 4 });
const superDb = drizzle(superClient, { schema });

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `spoc-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" })}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedProduct(
  tenantId: string,
): Promise<{ id: string; updatedAt: Date }> {
  const id = randomUUID();
  const slug = `p-${id.slice(0, 8)}`;
  const rows = await superDb.execute<{ updated_at: string }>(sql`
    INSERT INTO products (id, tenant_id, slug, name, status)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)},
      'draft')
    RETURNING updated_at::text AS updated_at
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ updated_at: string }> }).rows ?? []);
  return { id, updatedAt: new Date(arr[0]!.updated_at) };
}

async function readVariantIds(productId: string): Promise<string[]> {
  const rows = await superDb.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM product_variants WHERE product_id = ${productId} ORDER BY id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ id: string }> }).rows ?? []);
  return arr.map((r) => r.id);
}

async function readOptionIds(productId: string): Promise<string[]> {
  const rows = await superDb.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM product_options WHERE product_id = ${productId} ORDER BY id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ id: string }> }).rows ?? []);
  return arr.map((r) => r.id);
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

const colorEnAr = { en: "Color", ar: "اللون" };
const sizeEnAr = { en: "Size", ar: "المقاس" };
const redEnAr = { en: "Red", ar: "أحمر" };
const blueEnAr = { en: "Blue", ar: "أزرق" };
const smallEnAr = { en: "Small", ar: "صغير" };
const mediumEnAr = { en: "Medium", ar: "وسط" };

/**
 * Seed: product with options Color×{Red,Blue} and Size×{Small,Medium}, plus
 * four variants — one per cartesian tuple. Returns the ids needed for
 * subsequent cascade-removal calls.
 */
async function seedTwoOptionsAndAllFourVariants(tenantId: string) {
  const { setProductOptions } = await import(
    "@/server/services/variants/set-product-options"
  );
  const { setProductVariants } = await import(
    "@/server/services/variants/set-product-variants"
  );
  const product = await seedProduct(tenantId);
  const r1 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
    setProductOptions(tx, { id: tenantId }, "owner", {
      productId: product.id,
      expectedUpdatedAt: product.updatedAt.toISOString(),
      options: [
        {
          name: colorEnAr,
          values: [{ value: redEnAr }, { value: blueEnAr }],
        },
        {
          name: sizeEnAr,
          values: [{ value: smallEnAr }, { value: mediumEnAr }],
        },
      ],
    }),
  );
  const colorOption = r1.options[0]!;
  const sizeOption = r1.options[1]!;
  const redId = colorOption.values[0]!.id;
  const blueId = colorOption.values[1]!.id;
  const smallId = sizeOption.values[0]!.id;
  const mediumId = sizeOption.values[1]!.id;

  const r2 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
    setProductVariants(tx, { id: tenantId }, "owner", {
      productId: product.id,
      expectedUpdatedAt: r1.productUpdatedAt.toISOString(),
      variants: [
        {
          sku: `s-${randomUUID().slice(0, 8)}`,
          priceMinor: 100,
          stock: 1,
          optionValueIds: [redId, smallId],
        },
        {
          sku: `s-${randomUUID().slice(0, 8)}`,
          priceMinor: 200,
          stock: 2,
          optionValueIds: [redId, mediumId],
        },
        {
          sku: `s-${randomUUID().slice(0, 8)}`,
          priceMinor: 300,
          stock: 3,
          optionValueIds: [blueId, smallId],
        },
        {
          sku: `s-${randomUUID().slice(0, 8)}`,
          priceMinor: 400,
          stock: 4,
          optionValueIds: [blueId, mediumId],
        },
      ],
    }),
  );

  return {
    productId: product.id,
    productUpdatedAt: r2.productUpdatedAt,
    colorOptionId: colorOption.id,
    sizeOptionId: sizeOption.id,
    redId,
    blueId,
    smallId,
    mediumId,
    variants: r2.variants,
  };
}

describe("setProductOptions — cascade on option-type removal (1a.5.3)", () => {
  it("returns cascadedVariantIds=[] when no removal happens (no-cascade path is shape-stable)", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        options: [
          { name: colorEnAr, values: [{ value: redEnAr }] },
        ],
      }),
    );

    expect(result.cascadedVariantIds).toEqual([]);
  });

  it("removing one option type cascade-deletes every variant row referencing any of its values", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const seed = await seedTwoOptionsAndAllFourVariants(tenantId);

    // Drop the Color option type. Every variant references a Color
    // value-id, so all four variants must hard-delete.
    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: seed.productId,
        expectedUpdatedAt: seed.productUpdatedAt.toISOString(),
        options: [
          {
            id: seed.sizeOptionId,
            name: sizeEnAr,
            values: [
              { id: seed.smallId, value: smallEnAr },
              { id: seed.mediumId, value: mediumEnAr },
            ],
          },
        ],
      }),
    );

    // Cascade set carries every variant id in sorted order.
    const expectedIds = seed.variants.map((v) => v.id).sort();
    expect(result.cascadedVariantIds).toEqual(expectedIds);

    // Variants gone on disk.
    const remainingVariants = await readVariantIds(seed.productId);
    expect(remainingVariants).toEqual([]);

    // Color option row gone; Size option survives.
    const remainingOptions = await readOptionIds(seed.productId);
    expect(remainingOptions).toEqual([seed.sizeOptionId]);
  });

  it("removing one VALUE of a kept option type cascade-deletes only variants referencing that specific value", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const seed = await seedTwoOptionsAndAllFourVariants(tenantId);

    // Drop the Blue value of Color. Variants referencing Blue must
    // disappear; Red-* variants must survive.
    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: seed.productId,
        expectedUpdatedAt: seed.productUpdatedAt.toISOString(),
        options: [
          {
            id: seed.colorOptionId,
            name: colorEnAr,
            values: [{ id: seed.redId, value: redEnAr }],
          },
          {
            id: seed.sizeOptionId,
            name: sizeEnAr,
            values: [
              { id: seed.smallId, value: smallEnAr },
              { id: seed.mediumId, value: mediumEnAr },
            ],
          },
        ],
      }),
    );

    // Variants referencing the Blue value were Blue/Small + Blue/Medium.
    const blueVariantIds = seed.variants
      .filter(
        (v) =>
          v.optionValueIds.includes(seed.blueId) &&
          !v.optionValueIds.includes(seed.redId),
      )
      .map((v) => v.id)
      .sort();
    expect(result.cascadedVariantIds).toEqual(blueVariantIds);

    // The two surviving variants are Red/* — verify by id.
    const survivors = seed.variants
      .filter((v) => v.optionValueIds.includes(seed.redId))
      .map((v) => v.id)
      .sort();
    const onDisk = await readVariantIds(seed.productId);
    expect(onDisk.sort()).toEqual(survivors);
  });

  it("removing one option type AND one value of a kept option mixes correctly", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const seed = await seedTwoOptionsAndAllFourVariants(tenantId);

    // Drop the entire Size option type AND drop the Blue value of Color.
    // Result: every variant references either a Size value or a Blue
    // value — so all four variants disappear and only the Color/Red
    // option+value survives.
    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: seed.productId,
        expectedUpdatedAt: seed.productUpdatedAt.toISOString(),
        options: [
          {
            id: seed.colorOptionId,
            name: colorEnAr,
            values: [{ id: seed.redId, value: redEnAr }],
          },
        ],
      }),
    );

    const expected = seed.variants.map((v) => v.id).sort();
    expect(result.cascadedVariantIds).toEqual(expected);
    expect(await readVariantIds(seed.productId)).toEqual([]);

    // Sanity: Size option row gone; Color option survives.
    const remainingOptions = await readOptionIds(seed.productId);
    expect(remainingOptions).toEqual([seed.colorOptionId]);
  });

  it("cascade audit hash payload differs between the cascade-true and cascade-false runs (forensic detector)", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const seed = await seedTwoOptionsAndAllFourVariants(tenantId);
    // Snapshot a no-cascade rename of the Color option (no removals).
    const renameOnly = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: seed.productId,
        expectedUpdatedAt: seed.productUpdatedAt.toISOString(),
        options: [
          {
            id: seed.colorOptionId,
            name: { en: "Colour", ar: "اللون" },
            values: [
              { id: seed.redId, value: redEnAr },
              { id: seed.blueId, value: blueEnAr },
            ],
          },
          {
            id: seed.sizeOptionId,
            name: sizeEnAr,
            values: [
              { id: seed.smallId, value: smallEnAr },
              { id: seed.mediumId, value: mediumEnAr },
            ],
          },
        ],
      }),
    );
    expect(renameOnly.cascadedVariantIds).toEqual([]);
    const renameAfterHash = renameOnly.after.hash;

    // Now do a cascade-true run on a fresh seed and compare the after-
    // hash. The two cannot be byte-equal — cascade changes either the
    // option-id set or the value-id set in the post-state.
    const seed2 = await seedTwoOptionsAndAllFourVariants(tenantId);
    const cascade = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: seed2.productId,
        expectedUpdatedAt: seed2.productUpdatedAt.toISOString(),
        options: [
          {
            id: seed2.sizeOptionId,
            name: sizeEnAr,
            values: [
              { id: seed2.smallId, value: smallEnAr },
              { id: seed2.mediumId, value: mediumEnAr },
            ],
          },
        ],
      }),
    );
    expect(cascade.cascadedVariantIds.length).toBe(4);
    // The after-state on cascade has fewer optionIds — distinct hash.
    expect(cascade.after.hash).not.toBe(renameAfterHash);
    // The before-hash on cascade equals the after-hash on rename
    // (they're snapshots of the same on-disk state at successive
    // moments); we don't assert that — just that the post-state hashes
    // differ across cascade vs no-cascade post-states.
  });

  it("empty-options-input on a populated product cascade-removes EVERY option + variant", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const seed = await seedTwoOptionsAndAllFourVariants(tenantId);

    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: seed.productId,
        expectedUpdatedAt: seed.productUpdatedAt.toISOString(),
        options: [],
      }),
    );

    expect(result.cascadedVariantIds).toEqual(
      seed.variants.map((v) => v.id).sort(),
    );
    expect(await readVariantIds(seed.productId)).toEqual([]);
    expect(await readOptionIds(seed.productId)).toEqual([]);
    expect(result.options).toEqual([]);
  });

  it("cascadedVariantIds are sorted (ids only — no SKU, no localized text crosses)", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const seed = await seedTwoOptionsAndAllFourVariants(tenantId);

    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: seed.productId,
        expectedUpdatedAt: seed.productUpdatedAt.toISOString(),
        options: [],
      }),
    );

    // Sorted.
    const sorted = [...result.cascadedVariantIds].sort();
    expect(result.cascadedVariantIds).toEqual(sorted);

    // No SKU strings or localized text in the wire envelope's audit
    // snapshots. (`cascadedVariantIds` lives on `after`.)
    const serialized = JSON.stringify(result.after);
    expect(serialized).not.toMatch(/"sku"/);
    expect(serialized).not.toMatch(/"name"/);
    expect(serialized).not.toMatch(/"value"/);
  });
});
