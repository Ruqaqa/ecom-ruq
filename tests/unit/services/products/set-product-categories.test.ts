/**
 * `setProductCategories` service — chunk 1a.4.2.
 *
 * Set-replace contract:
 *   - `categoryIds` is the desired full set; service computes diff and
 *     applies attach/detach atomically inside the caller's tx.
 *   - Acquires the product under OCC: bumps `products.updated_at` and
 *     verifies the caller's `expectedUpdatedAt` matched. Empty result →
 *     disambiguate gone vs stale.
 *   - Existence-checks every desired categoryId under tenant scope with
 *     `FOR SHARE` (load-bearing — blocks concurrent soft-delete during
 *     the transaction).
 *   - Cross-tenant / soft-deleted / phantom uuids → BAD_REQUEST
 *     `category_not_found` (opaque; never echoes the offending id or
 *     constraint name).
 *   - Duplicate ids in input → deduped (Zod transform).
 *   - Empty array → detach all (valid input).
 *   - Defense-in-depth role gate → owner+staff.
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
  const slug = `spc-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" })}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedProduct(
  tenantId: string,
  opts: { deletedAt?: Date | null } = {},
): Promise<{ id: string; updatedAt: Date }> {
  const id = randomUUID();
  const slug = `p-${id.slice(0, 8)}`;
  const rows = await superDb.execute<{ updated_at: string }>(sql`
    INSERT INTO products (id, tenant_id, slug, name, status, deleted_at)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)},
      'draft',
      ${opts.deletedAt ? opts.deletedAt.toISOString() : null})
    RETURNING updated_at::text AS updated_at
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ updated_at: string }> }).rows ?? []);
  const ts = arr[0]?.updated_at ?? new Date().toISOString();
  return { id, updatedAt: new Date(ts) };
}

async function seedCategory(
  tenantId: string,
  opts: { deletedAt?: Date | null } = {},
): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `c-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO categories (id, tenant_id, slug, name, deleted_at)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "C", ar: "ف" })}'::jsonb`)},
      ${opts.deletedAt ? opts.deletedAt.toISOString() : null})
  `);
  return { id, slug };
}

async function readLinkedCategoryIds(productId: string): Promise<string[]> {
  const rows = await superDb.execute<{ category_id: string }>(sql`
    SELECT category_id::text AS category_id
    FROM product_categories
    WHERE product_id = ${productId}
    ORDER BY category_id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ category_id: string }> }).rows ?? []);
  return arr.map((r) => r.category_id);
}

async function readProductUpdatedAt(productId: string): Promise<Date> {
  const rows = await superDb.execute<{ updated_at: string }>(sql`
    SELECT updated_at::text AS updated_at FROM products WHERE id = ${productId}
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ updated_at: string }> }).rows ?? []);
  return new Date(arr[0]?.updated_at ?? new Date().toISOString());
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("setProductCategories — service", () => {
  it("happy path: attach two categories on a product with no current links", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const c1 = await seedCategory(tenantId);
    const c2 = await seedCategory(tenantId);

    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductCategories(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        categoryIds: [c1.id, c2.id],
      }),
    );

    expect(result.before.productId).toBe(product.id);
    expect(result.before.categories).toEqual([]);
    expect(
      [...result.after.categories.map((c) => c.id)].sort(),
    ).toEqual([c1.id, c2.id].sort());
    expect(
      [...result.after.categories.map((c) => c.slug)].sort(),
    ).toEqual([c1.slug, c2.slug].sort());
    expect(result.productUpdatedAt).toBeInstanceOf(Date);
    expect(
      result.productUpdatedAt.getTime(),
    ).toBeGreaterThanOrEqual(product.updatedAt.getTime());

    const linked = await readLinkedCategoryIds(product.id);
    expect(linked.sort()).toEqual([c1.id, c2.id].sort());
  });

  it("set-replace: detaches missing ids and attaches new ids in one call", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const a = await seedCategory(tenantId);
    const b = await seedCategory(tenantId);
    const c = await seedCategory(tenantId);

    // Pre-link {a, b}
    await superDb.execute(sql`
      INSERT INTO product_categories (tenant_id, product_id, category_id)
      VALUES (${tenantId}, ${product.id}, ${a.id}),
             (${tenantId}, ${product.id}, ${b.id})
    `);
    const updatedAt1 = await readProductUpdatedAt(product.id);

    // Set-replace to {b, c}: detach a, attach c, b unchanged.
    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductCategories(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: updatedAt1.toISOString(),
        categoryIds: [b.id, c.id],
      }),
    );
    expect([...result.before.categories.map((x) => x.id)].sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect([...result.after.categories.map((x) => x.id)].sort()).toEqual(
      [b.id, c.id].sort(),
    );

    const linked = await readLinkedCategoryIds(product.id);
    expect(linked.sort()).toEqual([b.id, c.id].sort());
  });

  it("empty array detaches all current links", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const a = await seedCategory(tenantId);
    await superDb.execute(sql`
      INSERT INTO product_categories (tenant_id, product_id, category_id)
      VALUES (${tenantId}, ${product.id}, ${a.id})
    `);
    const updatedAt1 = await readProductUpdatedAt(product.id);

    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductCategories(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: updatedAt1.toISOString(),
        categoryIds: [],
      }),
    );
    expect(result.before.categories).toHaveLength(1);
    expect(result.after.categories).toEqual([]);
    expect(await readLinkedCategoryIds(product.id)).toEqual([]);
  });

  it("duplicate ids in input are deduped silently", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const c1 = await seedCategory(tenantId);

    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductCategories(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        categoryIds: [c1.id, c1.id, c1.id],
      }),
    );
    expect(result.after.categories).toHaveLength(1);
    expect(result.after.categories[0]?.id).toBe(c1.id);
    expect(await readLinkedCategoryIds(product.id)).toEqual([c1.id]);
  });

  it("idempotent: setting the same categoryIds twice doesn't change links", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const c1 = await seedCategory(tenantId);
    const c2 = await seedCategory(tenantId);

    await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductCategories(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        categoryIds: [c1.id, c2.id],
      }),
    );
    const updatedAt2 = await readProductUpdatedAt(product.id);

    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductCategories(tx, { id: tenantId }, "owner", {
        productId: product.id,
        expectedUpdatedAt: updatedAt2.toISOString(),
        categoryIds: [c1.id, c2.id],
      }),
    );
    expect([...result.before.categories.map((x) => x.id)].sort()).toEqual(
      [c1.id, c2.id].sort(),
    );
    expect([...result.after.categories.map((x) => x.id)].sort()).toEqual(
      [c1.id, c2.id].sort(),
    );
    expect((await readLinkedCategoryIds(product.id)).sort()).toEqual(
      [c1.id, c2.id].sort(),
    );
  });

  it("cross-tenant categoryId → BAD_REQUEST 'category_not_found' (opaque)", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const product = await seedProduct(tenantA);
    const foreignCategory = await seedCategory(tenantB);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), (tx) =>
        setProductCategories(tx, { id: tenantA }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          categoryIds: [foreignCategory.id],
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("BAD_REQUEST");
    expect((caught as TRPCError).message).toBe("category_not_found");
    // Constraint names must NEVER leak.
    expect((caught as TRPCError).message).not.toContain(
      "product_categories_category_same_tenant_fk",
    );
    expect((caught as TRPCError).message).not.toContain(foreignCategory.id);
  });

  it("phantom (never-existed) categoryId → BAD_REQUEST 'category_not_found'", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductCategories(tx, { id: tenantId }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          categoryIds: [randomUUID()],
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("BAD_REQUEST");
    expect((caught as TRPCError).message).toBe("category_not_found");
  });

  it("soft-deleted category in input → BAD_REQUEST 'category_not_found'", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const removed = await seedCategory(tenantId, { deletedAt: new Date() });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductCategories(tx, { id: tenantId }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          categoryIds: [removed.id],
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).message).toBe("category_not_found");
  });

  it("cross-tenant productId → NOT_FOUND 'product_not_found' (opaque)", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productInB = await seedProduct(tenantB);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), (tx) =>
        setProductCategories(tx, { id: tenantA }, "owner", {
          productId: productInB.id,
          expectedUpdatedAt: productInB.updatedAt.toISOString(),
          categoryIds: [],
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
    expect((caught as TRPCError).message).toBe("product_not_found");
  });

  it("soft-deleted product → NOT_FOUND 'product_not_found'", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId, { deletedAt: new Date() });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductCategories(tx, { id: tenantId }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          categoryIds: [],
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
    expect((caught as TRPCError).message).toBe("product_not_found");
  });

  it("OCC mismatch on product row → StaleWriteError", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const c1 = await seedCategory(tenantId);
    // Out-of-band bump.
    await superDb.execute(
      sql`UPDATE products SET updated_at = now() + interval '1 second' WHERE id = ${product.id}`,
    );

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductCategories(tx, { id: tenantId }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          categoryIds: [c1.id],
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaleWriteError);
    // Categories not touched.
    expect(await readLinkedCategoryIds(product.id)).toEqual([]);
  });

  it("33-element array → Zod validation error (max 32)", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const ids = Array.from({ length: 33 }, () => randomUUID());

    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductCategories(tx, { id: tenantId }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          categoryIds: ids,
        }),
      ),
    ).rejects.toThrow();
  });

  it("inner role guard: customer rejected (defense-in-depth)", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        setProductCategories(tx, { id: tenantId }, "customer", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          categoryIds: [],
        }),
      ),
    ).rejects.toThrow(/role/i);
  });

  it("staff allowed (write role)", async () => {
    const { setProductCategories } = await import(
      "@/server/services/products/set-product-categories"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const c1 = await seedCategory(tenantId);
    const result = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      setProductCategories(tx, { id: tenantId }, "staff", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        categoryIds: [c1.id],
      }),
    );
    expect(result.after.categories).toHaveLength(1);
  });

  it("input schema has NO tenantId field (Low-02 invariant)", async () => {
    const { SetProductCategoriesInputSchema } = await import(
      "@/server/services/products/set-product-categories"
    );
    expect(Object.keys(SetProductCategoriesInputSchema.shape)).not.toContain(
      "tenantId",
    );
  });

  it("input schema has NO role field", async () => {
    const { SetProductCategoriesInputSchema } = await import(
      "@/server/services/products/set-product-categories"
    );
    expect(Object.keys(SetProductCategoriesInputSchema.shape)).not.toContain(
      "role",
    );
  });
});
