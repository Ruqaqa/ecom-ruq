/**
 * `setProductOptions` service — chunk 1a.5.1.
 *
 * Set-replace contract for the option-type axes on a single product.
 * Mirrors `setProductCategories` for OCC + advisory-lock + cross-tenant
 * opacity, plus its own behaviour for diff/insert/update of options +
 * values. 1a.5.1 explicitly REFUSES removal (cascade flow lives in
 * 1a.5.3) — the spec §1 calls this "option_remove_not_supported_yet".
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import * as schema from "@/server/db/schema";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { StaleWriteError } from "@/server/audit/error-codes";

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
  const slug = `spo-${id.slice(0, 8)}`;
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

async function readOptionRows(productId: string) {
  const rows = await superDb.execute<{
    id: string;
    name: { en: string; ar: string };
    position: number;
  }>(sql`
    SELECT id::text AS id, name, position
    FROM product_options
    WHERE product_id = ${productId}
    ORDER BY position, id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<unknown> }).rows ?? []);
  return arr as Array<{ id: string; name: { en: string; ar: string }; position: number }>;
}

async function readValueRows(optionId: string) {
  const rows = await superDb.execute<{
    id: string;
    value: { en: string; ar: string };
    position: number;
  }>(sql`
    SELECT id::text AS id, value, position
    FROM product_option_values
    WHERE option_id = ${optionId}
    ORDER BY position, id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<unknown> }).rows ?? []);
  return arr as Array<{ id: string; value: { en: string; ar: string }; position: number }>;
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

describe("setProductOptions — happy path", () => {
  it("inserts new option types with values on a product that has none", async () => {
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

    expect(result.options).toHaveLength(2);
    expect(result.options[0]!.name).toEqual(colorEnAr);
    expect(result.options[0]!.position).toBe(0);
    expect(result.options[0]!.values).toHaveLength(2);
    expect(result.options[0]!.values[0]!.value).toEqual(redEnAr);
    expect(result.options[1]!.name).toEqual(sizeEnAr);
    expect(result.options[1]!.position).toBe(1);

    // Audit `before` is the empty-set snapshot, `after` the new set.
    expect(result.before.optionsCount).toBe(0);
    expect(result.before.valuesCount).toBe(0);
    expect(result.after.optionsCount).toBe(2);
    expect(result.after.valuesCount).toBe(4);
    expect(result.after.optionIds.sort()).toEqual(
      [
        result.options[0]!.id,
        result.options[1]!.id,
      ].sort(),
    );

    // Wire return reflects on-disk rows.
    const dbOptions = await readOptionRows(product.id);
    expect(dbOptions).toHaveLength(2);
    const dbValues0 = await readValueRows(dbOptions[0]!.id);
    expect(dbValues0).toHaveLength(2);
  });

  it("preserves an option id when the operator passes it back (rename without re-insert)", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    // Round 1 — insert one option.
    const r1 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        options: [
          { name: colorEnAr, values: [{ value: redEnAr }] },
        ],
      }),
    );
    const colorOptionId = r1.options[0]!.id;
    const colorValueId = r1.options[0]!.values[0]!.id;

    // Round 2 — rename the option but include both ids. Should preserve identity.
    const updatedAt2 = r1.productUpdatedAt;
    const r2 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: updatedAt2.toISOString(),
        options: [
          {
            id: colorOptionId,
            name: { en: "Colour", ar: "اللون" },
            values: [
              { id: colorValueId, value: { en: "Crimson", ar: "أحمر" } },
            ],
          },
        ],
      }),
    );
    expect(r2.options[0]!.id).toBe(colorOptionId);
    expect(r2.options[0]!.name).toEqual({ en: "Colour", ar: "اللون" });
    expect(r2.options[0]!.values[0]!.id).toBe(colorValueId);
    expect(r2.options[0]!.values[0]!.value).toEqual({
      en: "Crimson",
      ar: "أحمر",
    });
    // Rename-only audit invariant: localized text is intentionally
    // EXCLUDED from the bounded audit snapshot (spec §7 — keeps PDPL-
    // undeletable storage free of buyer-derived copy). The hash is
    // computed over ids + positions + value-id sets (+ cascadedVariantIds
    // on `after` per 1a.5.3), so renaming 'Color' → 'Colour' does NOT
    // shift the structural id-set. The id-set + value-id-set remain
    // stable across the rename. The cascadedVariantIds is empty here
    // (no removal), so the only post-1a.5.3 hash-payload delta vs the
    // `before` snapshot is the inclusion of an empty `cascadedVariantIds`
    // key on `after`'s hash payload — that makes the two hashes
    // legitimately distinct in the new scheme. The structural-stability
    // invariant the original 1a.5.1 test guarded is now expressed as
    // optionIds + valueIds equality across snapshots:
    expect(r2.before.optionIds).toEqual(r2.after.optionIds);
    expect(r2.before.valueIds).toEqual(r2.after.valueIds);
    expect(r2.after.cascadedVariantIds).toEqual([]);
  });

  it("clears all options when input is empty (1a.5.3 cascade — no variants reference them, so cascadedVariantIds is empty)", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const r1 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        options: [
          { name: colorEnAr, values: [{ value: redEnAr }] },
        ],
      }),
    );

    // 1a.5.3 SPEC: removing an option type cascades into hard-deleting
    // every variant referencing any of its values. With zero variants
    // pre-existing, the cascade set is empty and the option simply
    // drops.
    const r2 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: r1.productUpdatedAt.toISOString(),
        options: [],
      }),
    );
    expect(r2.options).toEqual([]);
    expect(r2.cascadedVariantIds).toEqual([]);
    expect(r2.after.optionsCount).toBe(0);
  });
});

describe("setProductOptions — caps and refinements", () => {
  it("Zod rejects > 3 option types per product", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductOptions(tx, { id: tenantId }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          options: [
            { name: { en: "A", ar: "ا" }, values: [{ value: redEnAr }] },
            { name: { en: "B", ar: "ب" }, values: [{ value: redEnAr }] },
            { name: { en: "C", ar: "ج" }, values: [{ value: redEnAr }] },
            { name: { en: "D", ar: "د" }, values: [{ value: redEnAr }] },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it("Zod rejects an option with zero values", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductOptions(tx, { id: tenantId }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          options: [{ name: colorEnAr, values: [] }],
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("setProductOptions — OCC and product existence", () => {
  it("stale expectedUpdatedAt → StaleWriteError", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    const stale = new Date(product.updatedAt.getTime() - 60_000);
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductOptions(tx, { id: tenantId }, "owner", {
          productId: product.id,
          expectedUpdatedAt: stale.toISOString(),
          options: [
            { name: colorEnAr, values: [{ value: redEnAr }] },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(StaleWriteError);
  });

  it("phantom productId → NOT_FOUND product_not_found (opaque)", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const phantom = randomUUID();

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductOptions(tx, { id: tenantId }, "owner", {
          productId: phantom,
          expectedUpdatedAt: new Date().toISOString(),
          options: [
            { name: colorEnAr, values: [{ value: redEnAr }] },
          ],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
    expect((caught as TRPCError).message).toBe("product_not_found");
  });

  it("cross-tenant productId → NOT_FOUND product_not_found (byte-equal to phantom)", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productB = await seedProduct(tenantB);

    let crossTenantErr: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), (tx) =>
        setProductOptions(tx, { id: tenantA }, "owner", {
          productId: productB.id,
          expectedUpdatedAt: productB.updatedAt.toISOString(),
          options: [
            { name: colorEnAr, values: [{ value: redEnAr }] },
          ],
        }),
      );
    } catch (err) {
      crossTenantErr = err;
    }
    expect(crossTenantErr).toBeInstanceOf(TRPCError);
    expect((crossTenantErr as TRPCError).code).toBe("NOT_FOUND");
    expect((crossTenantErr as TRPCError).message).toBe("product_not_found");
  });
});

describe("setProductOptions — option/value cross-tenant opacity", () => {
  it("input optionId belonging to a different product (same tenant) → BAD_REQUEST option_not_found", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const productA = await seedProduct(tenantId);
    const productB = await seedProduct(tenantId);

    // Plant an option on product B.
    const r = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: productB.id,
        expectedUpdatedAt: productB.updatedAt.toISOString(),
        options: [
          { name: colorEnAr, values: [{ value: redEnAr }] },
        ],
      }),
    );
    const productBOptionId = r.options[0]!.id;

    // Try to use that optionId in a setProductOptions call against productA.
    let err: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductOptions(tx, { id: tenantId }, "owner", {
          productId: productA.id,
          expectedUpdatedAt: productA.updatedAt.toISOString(),
          options: [
            {
              id: productBOptionId,
              name: colorEnAr,
              values: [{ value: redEnAr }],
            },
          ],
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toBe("option_not_found");
  });

  it("input value id belonging to a different option (same product, same tenant) → BAD_REQUEST option_value_not_found", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    // Plant two options.
    const r1 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        options: [
          { name: colorEnAr, values: [{ value: redEnAr }] },
          { name: sizeEnAr, values: [{ value: smallEnAr }] },
        ],
      }),
    );
    const colorOption = r1.options[0]!;
    const sizeOption = r1.options[1]!;
    const sizeValueId = sizeOption.values[0]!.id;

    // Try to attach the SIZE value id under the COLOR option.
    let err: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductOptions(tx, { id: tenantId }, "owner", {
          productId: product.id,
          expectedUpdatedAt: r1.productUpdatedAt.toISOString(),
          options: [
            {
              id: colorOption.id,
              name: colorEnAr,
              values: [
                // Foreign value id from the size option.
                { id: sizeValueId, value: redEnAr },
              ],
            },
            {
              id: sizeOption.id,
              name: sizeEnAr,
              values: [{ value: smallEnAr }],
            },
          ],
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toBe("option_value_not_found");
  });
});

describe("setProductOptions — role gate", () => {
  it("non-write role throws (defense-in-depth: transport gates first, this catches wiring bugs)", async () => {
    const { setProductOptions } = await import(
      "@/server/services/variants/set-product-options"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductOptions(tx, { id: tenantId }, "customer", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          options: [{ name: colorEnAr, values: [{ value: redEnAr }] }],
        }),
      ),
    ).rejects.toThrow();
  });
});
