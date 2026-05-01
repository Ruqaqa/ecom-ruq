/**
 * `setProductVariants` service — chunk 1a.5.1.
 *
 * Set-replace contract for the variant rows on a single product. Hard
 * delete on diff-removal (variant rows have no `deletedAt`; the parent
 * product's soft-delete is the broader recovery net per spec §1).
 *
 * Spec invariants exercised here:
 *   - OCC anchored on the parent product row.
 *   - Per-product advisory lock serialises against concurrent edits.
 *   - Tuple-shape: every variant references EXACTLY one value per
 *     option type the product currently defines (1a.5.3 cascade
 *     prerequisite — security flagged this as load-bearing).
 *   - No duplicate `optionValueIds` tuples across the input.
 *   - Cross-tenant / wrong-product / phantom value-ids → opaque
 *     `option_value_not_found`.
 *   - SKU collision within tenant → `SkuTakenError` (wire-translated to
 *     CONFLICT `sku_taken`); cross-tenant SKUs do NOT collide.
 *   - Single-default mode when the product defines zero options.
 *   - Caps: ≤100 variants per product (Zod-enforced).
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
import { SkuTakenError, StaleWriteError } from "@/server/audit/error-codes";

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
  const slug = `spv-${id.slice(0, 8)}`;
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

/**
 * Convenience: seed two option types ("Color"/[Red,Blue], "Size"/[S,M])
 * on a product through the live setProductOptions service. Keeps the
 * test data realistic (live ids, correct positions, correct cartesian).
 */
async function seedProductWithTwoOptions(tenantId: string) {
  const { setProductOptions } = await import(
    "@/server/services/variants/set-product-options"
  );
  const product = await seedProduct(tenantId);
  const r = await withTenant(
    superDb,
    buildAuthedTenantContext(
      { id: tenantId },
      { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
    ),
    (tx) =>
      setProductOptions(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        options: [
          {
            name: { en: "Color", ar: "اللون" },
            values: [
              { value: { en: "Red", ar: "أحمر" } },
              { value: { en: "Blue", ar: "أزرق" } },
            ],
          },
          {
            name: { en: "Size", ar: "المقاس" },
            values: [
              { value: { en: "Small", ar: "صغير" } },
              { value: { en: "Medium", ar: "وسط" } },
            ],
          },
        ],
      }),
  );
  return {
    productId: product.id,
    productUpdatedAt: r.productUpdatedAt,
    colorOptionId: r.options[0]!.id,
    sizeOptionId: r.options[1]!.id,
    redValueId: r.options[0]!.values[0]!.id,
    blueValueId: r.options[0]!.values[1]!.id,
    smallValueId: r.options[1]!.values[0]!.id,
    mediumValueId: r.options[1]!.values[1]!.id,
  };
}

async function readVariantSkus(productId: string): Promise<string[]> {
  const rows = await superDb.execute<{ sku: string }>(sql`
    SELECT sku FROM product_variants WHERE product_id = ${productId} ORDER BY sku
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ sku: string }> }).rows ?? []);
  return arr.map((r) => r.sku);
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("setProductVariants — happy path", () => {
  it("inserts a full cartesian product (2 options × 2 values = 4 variants)", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    const seed = await seedProductWithTwoOptions(tenantId);

    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductVariants(tx, { id: tenantId }, "owner", {
        productId: seed.productId,
        expectedUpdatedAt: seed.productUpdatedAt.toISOString(),
        variants: [
          {
            sku: "RED-S",
            priceMinor: 1000,
            stock: 5,
            optionValueIds: [seed.redValueId, seed.smallValueId],
          },
          {
            sku: "RED-M",
            priceMinor: 1000,
            stock: 5,
            optionValueIds: [seed.redValueId, seed.mediumValueId],
          },
          {
            sku: "BLUE-S",
            priceMinor: 1100,
            stock: 0,
            optionValueIds: [seed.blueValueId, seed.smallValueId],
          },
          {
            sku: "BLUE-M",
            priceMinor: 1100,
            stock: 0,
            optionValueIds: [seed.blueValueId, seed.mediumValueId],
          },
        ],
      }),
    );
    expect(result.variants).toHaveLength(4);
    expect(result.before.count).toBe(0);
    expect(result.after.count).toBe(0 + 4); // before empty, after 4
    expect(result.after.hash).not.toBe(result.before.hash);
    // Spec §7: skuHash dropped — snapshot keyset is exactly count, hash, ids, productId.
    expect(Object.keys(result.after).sort()).toEqual([
      "count",
      "hash",
      "ids",
      "productId",
    ]);

    const skus = await readVariantSkus(seed.productId);
    expect(skus).toEqual(["BLUE-M", "BLUE-S", "RED-M", "RED-S"]);
  });

  it("set-replace: hard-deletes a variant whose id is missing from input", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    const seed = await seedProductWithTwoOptions(tenantId);

    // Seed 4 variants.
    const r1 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductVariants(tx, { id: tenantId }, "owner", {
        productId: seed.productId,
        expectedUpdatedAt: seed.productUpdatedAt.toISOString(),
        variants: [
          {
            sku: "RED-S",
            priceMinor: 1000,
            stock: 5,
            optionValueIds: [seed.redValueId, seed.smallValueId],
          },
          {
            sku: "RED-M",
            priceMinor: 1000,
            stock: 5,
            optionValueIds: [seed.redValueId, seed.mediumValueId],
          },
          {
            sku: "BLUE-S",
            priceMinor: 1100,
            stock: 0,
            optionValueIds: [seed.blueValueId, seed.smallValueId],
          },
          {
            sku: "BLUE-M",
            priceMinor: 1100,
            stock: 0,
            optionValueIds: [seed.blueValueId, seed.mediumValueId],
          },
        ],
      }),
    );
    const blueS = r1.variants.find((v) => v.sku === "BLUE-S")!;
    const blueM = r1.variants.find((v) => v.sku === "BLUE-M")!;

    // Round 2: drop the two RED rows (omit them).
    const r2 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductVariants(tx, { id: tenantId }, "owner", {
        productId: seed.productId,
        expectedUpdatedAt: r1.productUpdatedAt.toISOString(),
        variants: [
          {
            id: blueS.id,
            sku: "BLUE-S",
            priceMinor: 1100,
            stock: 0,
            optionValueIds: [seed.blueValueId, seed.smallValueId],
          },
          {
            id: blueM.id,
            sku: "BLUE-M",
            priceMinor: 1100,
            stock: 0,
            optionValueIds: [seed.blueValueId, seed.mediumValueId],
          },
        ],
      }),
    );
    expect(r2.variants).toHaveLength(2);
    expect(r2.before.count).toBe(4);
    expect(r2.after.count).toBe(2);
    const skus = await readVariantSkus(seed.productId);
    expect(skus).toEqual(["BLUE-M", "BLUE-S"]);
  });

  it("single-default mode: zero options + one empty-tuple variant accepted", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductVariants(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        variants: [
          {
            sku: "DEFAULT-1",
            priceMinor: 999,
            stock: 1,
            optionValueIds: [],
          },
        ],
      }),
    );
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]!.optionValueIds).toEqual([]);
  });

  it("single-default rejection: zero options + two empty-tuple variants → default_variant_required", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    let err: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductVariants(tx, { id: tenantId }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          variants: [
            {
              sku: "DEFAULT-1",
              priceMinor: 100,
              stock: 0,
              optionValueIds: [],
            },
            {
              sku: "DEFAULT-2",
              priceMinor: 200,
              stock: 0,
              optionValueIds: [],
            },
          ],
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toBe("default_variant_required");
  });
});

describe("setProductVariants — tuple-shape and dup", () => {
  it("variant tuple length must equal current option count → option_value_not_found", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    const seed = await seedProductWithTwoOptions(tenantId);

    let err: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductVariants(tx, { id: tenantId }, "owner", {
          productId: seed.productId,
          expectedUpdatedAt: seed.productUpdatedAt.toISOString(),
          variants: [
            {
              sku: "ONE-VAL-ONLY",
              priceMinor: 100,
              stock: 0,
              optionValueIds: [seed.redValueId],
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

  it("duplicate optionValueIds tuples in input → duplicate_variant_combination", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    const seed = await seedProductWithTwoOptions(tenantId);

    let err: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductVariants(tx, { id: tenantId }, "owner", {
          productId: seed.productId,
          expectedUpdatedAt: seed.productUpdatedAt.toISOString(),
          variants: [
            {
              sku: "RED-S-A",
              priceMinor: 100,
              stock: 0,
              optionValueIds: [seed.redValueId, seed.smallValueId],
            },
            {
              sku: "RED-S-B",
              priceMinor: 200,
              stock: 0,
              optionValueIds: [seed.redValueId, seed.smallValueId],
            },
          ],
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toBe("duplicate_variant_combination");
  });
});

describe("setProductVariants — caps", () => {
  it("Zod rejects > 100 variants", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    const seed = await seedProductWithTwoOptions(tenantId);

    const tooMany = Array.from({ length: 101 }, (_, i) => ({
      sku: `SKU-${i}`,
      priceMinor: 100,
      stock: 0,
      optionValueIds: [seed.redValueId, seed.smallValueId],
    }));
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductVariants(tx, { id: tenantId }, "owner", {
          productId: seed.productId,
          expectedUpdatedAt: seed.productUpdatedAt.toISOString(),
          variants: tooMany,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("setProductVariants — SKU uniqueness", () => {
  it("collision within tenant across different products → SkuTakenError", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    // Product A — claim SKU "DUPE-X".
    const productA = await seedProduct(tenantId);
    await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductVariants(tx, { id: tenantId }, "owner", {
        productId: productA.id,
        expectedUpdatedAt: productA.updatedAt.toISOString(),
        variants: [
          {
            sku: "DUPE-X",
            priceMinor: 100,
            stock: 0,
            optionValueIds: [],
          },
        ],
      }),
    );
    // Product B — try to claim the same SKU.
    const productB = await seedProduct(tenantId);
    let err: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductVariants(tx, { id: tenantId }, "owner", {
          productId: productB.id,
          expectedUpdatedAt: productB.updatedAt.toISOString(),
          variants: [
            {
              sku: "DUPE-X",
              priceMinor: 200,
              stock: 0,
              optionValueIds: [],
            },
          ],
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SkuTakenError);
    // Closed-set message; offending SKU never echoed.
    expect((err as SkuTakenError).message).toBe("sku_taken");
    expect((err as SkuTakenError).message).not.toContain("DUPE-X");
  });

  it("cross-tenant SKU does NOT collide", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productA = await seedProduct(tenantA);
    const productB = await seedProduct(tenantB);

    await withTenant(superDb, ctxFor(tenantA), (tx) =>
      setProductVariants(tx, { id: tenantA }, "owner", {
        productId: productA.id,
        expectedUpdatedAt: productA.updatedAt.toISOString(),
        variants: [
          {
            sku: "ACROSS-TENANTS",
            priceMinor: 100,
            stock: 0,
            optionValueIds: [],
          },
        ],
      }),
    );
    // Tenant B can claim the same SKU — unique index is (tenant_id, sku).
    const r = await withTenant(superDb, ctxFor(tenantB), (tx) =>
      setProductVariants(tx, { id: tenantB }, "owner", {
        productId: productB.id,
        expectedUpdatedAt: productB.updatedAt.toISOString(),
        variants: [
          {
            sku: "ACROSS-TENANTS",
            priceMinor: 200,
            stock: 0,
            optionValueIds: [],
          },
        ],
      }),
    );
    expect(r.variants).toHaveLength(1);
    expect(r.variants[0]!.sku).toBe("ACROSS-TENANTS");
  });

  it("cross-tenant SKU success leaves NO audit ripple on the originating tenant (existence-leak guard)", async () => {
    // Spec §4 test case 6 (security-added). The unique index is
    // (tenant_id, sku) — tenant B can claim a SKU that tenant A
    // already uses without colliding. Beyond that, B's call must
    // not write any audit row scoped to tenant A as a side-effect:
    // a probe could otherwise infer "SKU X exists in some tenant"
    // by observing the audit-row presence, even when the wire
    // response shows success.
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productA = await seedProduct(tenantA);
    const productB = await seedProduct(tenantB);

    // Tenant A claims SKU "X".
    await withTenant(superDb, ctxFor(tenantA), (tx) =>
      setProductVariants(tx, { id: tenantA }, "owner", {
        productId: productA.id,
        expectedUpdatedAt: productA.updatedAt.toISOString(),
        variants: [
          {
            sku: "PROBE-LEAK-X",
            priceMinor: 100,
            stock: 0,
            optionValueIds: [],
          },
        ],
      }),
    );
    // Snapshot the audit-row count for tenant A AFTER the legitimate
    // tenant-A write. Anything beyond this counter on the next read
    // implies B's call rippled into A's audit chain.
    const auditCountBefore = await superDb.execute<{ c: string }>(sql`
      SELECT COUNT(*)::text AS c FROM audit_log WHERE tenant_id = ${tenantA}
    `);
    const beforeArr = Array.isArray(auditCountBefore)
      ? auditCountBefore
      : ((auditCountBefore as { rows?: Array<{ c: string }> }).rows ?? []);
    const before = parseInt(beforeArr[0]?.c ?? "0", 10);

    // Tenant B claims the same SKU — same string.
    await withTenant(superDb, ctxFor(tenantB), (tx) =>
      setProductVariants(tx, { id: tenantB }, "owner", {
        productId: productB.id,
        expectedUpdatedAt: productB.updatedAt.toISOString(),
        variants: [
          {
            sku: "PROBE-LEAK-X",
            priceMinor: 200,
            stock: 0,
            optionValueIds: [],
          },
        ],
      }),
    );

    const auditCountAfter = await superDb.execute<{ c: string }>(sql`
      SELECT COUNT(*)::text AS c FROM audit_log WHERE tenant_id = ${tenantA}
    `);
    const afterArr = Array.isArray(auditCountAfter)
      ? auditCountAfter
      : ((auditCountAfter as { rows?: Array<{ c: string }> }).rows ?? []);
    const after = parseInt(afterArr[0]?.c ?? "0", 10);

    // No audit ripple on tenant A from B's call.
    expect(after).toBe(before);
  });

  it("SKU resurfacing edge case: Product A removes SKU, Product B claims it, Product A resubmits → SkuTakenError", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    const productA = await seedProduct(tenantId);

    // 1. Product A claims SKU "RES".
    const a1 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductVariants(tx, { id: tenantId }, "owner", {
        productId: productA.id,
        expectedUpdatedAt: productA.updatedAt.toISOString(),
        variants: [
          {
            sku: "RES",
            priceMinor: 100,
            stock: 0,
            optionValueIds: [],
          },
        ],
      }),
    );
    // 2. Product A removes its variant (set to a different SKU effectively
    //    hard-deletes the old row + inserts a new one).
    const a2 = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductVariants(tx, { id: tenantId }, "owner", {
        productId: productA.id,
        expectedUpdatedAt: a1.productUpdatedAt.toISOString(),
        variants: [
          {
            sku: "RES-OTHER",
            priceMinor: 100,
            stock: 0,
            optionValueIds: [],
          },
        ],
      }),
    );
    // 3. Product B picks up "RES".
    const productB = await seedProduct(tenantId);
    await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductVariants(tx, { id: tenantId }, "owner", {
        productId: productB.id,
        expectedUpdatedAt: productB.updatedAt.toISOString(),
        variants: [
          {
            sku: "RES",
            priceMinor: 200,
            stock: 0,
            optionValueIds: [],
          },
        ],
      }),
    );
    // 4. Product A tries to add "RES" again.
    let err: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductVariants(tx, { id: tenantId }, "owner", {
          productId: productA.id,
          expectedUpdatedAt: a2.productUpdatedAt.toISOString(),
          variants: [
            {
              sku: "RES",
              priceMinor: 300,
              stock: 0,
              optionValueIds: [],
            },
          ],
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SkuTakenError);
  });
});

describe("setProductVariants — OCC and existence", () => {
  it("stale expectedUpdatedAt → StaleWriteError", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    const seed = await seedProductWithTwoOptions(tenantId);

    const stale = new Date(seed.productUpdatedAt.getTime() - 60_000);
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductVariants(tx, { id: tenantId }, "owner", {
          productId: seed.productId,
          expectedUpdatedAt: stale.toISOString(),
          variants: [
            {
              sku: "X",
              priceMinor: 100,
              stock: 0,
              optionValueIds: [seed.redValueId, seed.smallValueId],
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(StaleWriteError);
  });

  it("phantom productId → NOT_FOUND product_not_found", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    let err: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductVariants(tx, { id: tenantId }, "owner", {
          productId: randomUUID(),
          expectedUpdatedAt: new Date().toISOString(),
          variants: [
            {
              sku: "X",
              priceMinor: 100,
              stock: 0,
              optionValueIds: [],
            },
          ],
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("NOT_FOUND");
    expect((err as TRPCError).message).toBe("product_not_found");
  });
});

describe("setProductVariants — cross-tenant value-id opacity", () => {
  it("optionValueId belonging to a different product (same tenant) → BAD_REQUEST option_value_not_found", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantId = await makeTenant();
    const seedA = await seedProductWithTwoOptions(tenantId);
    // Build a SECOND product on the same tenant — to source a same-
    // tenant-but-wrong-product valueId.
    const seedB = await seedProductWithTwoOptions(tenantId);

    // Try to attach product B's value-ids to a variant on product A.
    let err: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductVariants(tx, { id: tenantId }, "owner", {
          productId: seedA.productId,
          expectedUpdatedAt: seedA.productUpdatedAt.toISOString(),
          variants: [
            {
              sku: "X",
              priceMinor: 100,
              stock: 0,
              optionValueIds: [seedB.redValueId, seedB.smallValueId],
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

  it("optionValueId belonging to another tenant → BAD_REQUEST option_value_not_found", async () => {
    const { setProductVariants } = await import(
      "@/server/services/variants/set-product-variants"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const seedA = await seedProductWithTwoOptions(tenantA);
    const seedB = await seedProductWithTwoOptions(tenantB);

    let err: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), (tx) =>
        setProductVariants(tx, { id: tenantA }, "owner", {
          productId: seedA.productId,
          expectedUpdatedAt: seedA.productUpdatedAt.toISOString(),
          variants: [
            {
              sku: "X",
              priceMinor: 100,
              stock: 0,
              // Cross-tenant value-ids.
              optionValueIds: [seedB.redValueId, seedB.smallValueId],
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
