/**
 * Contract test for the e2e global-setup catalog sweep.
 *
 * The `/admin/categories` page renders its full tree without pagination
 * (depth-3 cap means a real tenant has at most a few hundred). Without a
 * sweep between e2e runs, prior runs leak `e2e-`-prefixed rows into the
 * dev tenant; on a developer machine the count climbs into the thousands
 * over time. WebKit's axe-core is then too slow to walk the resulting
 * DOM and `axe.runPartial` times out — the failure surfaces only on the
 * iPhone projects (Chromium handles the larger DOM fine).
 *
 * The fix is in `tests/e2e/global-setup.ts`: a `DELETE` of
 * `e2e-`-prefixed categories and products on the dev tenant. This test
 * exercises that delete against the real dev DB to guarantee:
 *   1. `e2e-`-prefixed catalog rows are removed,
 *   2. non-prefixed catalog rows are preserved,
 *   3. cascading FKs (`product_categories`, child categories) clean up
 *      transitively.
 *
 * If this test fails, the iPhone-only axe timeout will return.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const sql = postgres(DATABASE_URL, { max: 1 });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function getDevTenantId(): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id::text AS id FROM tenants WHERE primary_domain = 'localhost:5001'
  `;
  if (rows.length === 0) {
    throw new Error(
      "dev tenant not seeded — run `pnpm services:up` and the seed script first",
    );
  }
  return rows[0]!.id;
}

async function runCatalogSweep(devTenantId: string): Promise<void> {
  // Mirrors the DELETE statements in tests/e2e/global-setup.ts. Kept in
  // sync here so the contract is asserted independently of importing
  // and running the full global-setup (which also touches Redis,
  // Mailpit, and access_tokens).
  await sql`
    DELETE FROM products
    WHERE tenant_id = ${devTenantId}
      AND slug LIKE 'e2e-%'
  `;
  await sql`
    DELETE FROM categories
    WHERE tenant_id = ${devTenantId}
      AND slug LIKE 'e2e-%'
  `;
}

describe("e2e global-setup catalog sweep", () => {
  it("removes e2e-prefixed categories on the dev tenant", async () => {
    const devTenantId = await getDevTenantId();
    const e2eSlug = `e2e-sweep-${randomUUID().slice(0, 8)}`;

    await sql`
      INSERT INTO categories (tenant_id, slug, name)
      VALUES (${devTenantId}, ${e2eSlug}, ${sql.json({ en: "S", ar: "س" })})
    `;

    await runCatalogSweep(devTenantId);

    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM categories WHERE tenant_id = ${devTenantId} AND slug = ${e2eSlug}
    `;
    expect(rows).toEqual([]);
  });

  it("removes e2e-prefixed products on the dev tenant", async () => {
    const devTenantId = await getDevTenantId();
    const e2eSlug = `e2e-sweep-${randomUUID().slice(0, 8)}`;

    await sql`
      INSERT INTO products (tenant_id, slug, name, status)
      VALUES (${devTenantId}, ${e2eSlug},
        ${sql.json({ en: "S", ar: "س" })}, 'draft')
    `;

    await runCatalogSweep(devTenantId);

    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM products WHERE tenant_id = ${devTenantId} AND slug = ${e2eSlug}
    `;
    expect(rows).toEqual([]);
  });

  it("preserves non-e2e-prefixed catalog rows on the dev tenant", async () => {
    const devTenantId = await getDevTenantId();
    const survivorSlug = `manual-sweep-${randomUUID().slice(0, 8)}`;

    await sql`
      INSERT INTO categories (tenant_id, slug, name)
      VALUES (${devTenantId}, ${survivorSlug}, ${sql.json({ en: "S", ar: "س" })})
    `;
    try {
      await runCatalogSweep(devTenantId);
      const rows = await sql<Array<{ id: string }>>`
        SELECT id FROM categories WHERE tenant_id = ${devTenantId} AND slug = ${survivorSlug}
      `;
      expect(rows).toHaveLength(1);
    } finally {
      // Clean up the survivor — leaving it would inflate the page over
      // time exactly like the bug under test.
      await sql`DELETE FROM categories WHERE tenant_id = ${devTenantId} AND slug = ${survivorSlug}`;
    }
  });

  it("cascades through product_categories and child categories", async () => {
    const devTenantId = await getDevTenantId();
    const parentSlug = `e2e-sweep-parent-${randomUUID().slice(0, 8)}`;
    const childSlug = `e2e-sweep-child-${randomUUID().slice(0, 8)}`;
    const productSlug = `e2e-sweep-prod-${randomUUID().slice(0, 8)}`;

    const parentRows = await sql<Array<{ id: string }>>`
      INSERT INTO categories (tenant_id, slug, name)
      VALUES (${devTenantId}, ${parentSlug}, ${sql.json({ en: "P", ar: "ب" })})
      RETURNING id::text AS id
    `;
    const parentId = parentRows[0]!.id;

    const childRows = await sql<Array<{ id: string }>>`
      INSERT INTO categories (tenant_id, slug, name, parent_id)
      VALUES (${devTenantId}, ${childSlug}, ${sql.json({ en: "C", ar: "ج" })}, ${parentId})
      RETURNING id::text AS id
    `;
    const childId = childRows[0]!.id;

    const productRows = await sql<Array<{ id: string }>>`
      INSERT INTO products (tenant_id, slug, name, status)
      VALUES (${devTenantId}, ${productSlug},
        ${sql.json({ en: "X", ar: "س" })}, 'draft')
      RETURNING id::text AS id
    `;
    const productId = productRows[0]!.id;

    await sql`
      INSERT INTO product_categories (tenant_id, product_id, category_id)
      VALUES (${devTenantId}, ${productId}, ${parentId})
    `;

    await runCatalogSweep(devTenantId);

    const remainingCategories = await sql<Array<{ id: string }>>`
      SELECT id FROM categories WHERE id IN (${parentId}, ${childId})
    `;
    expect(remainingCategories).toEqual([]);

    const remainingProducts = await sql<Array<{ id: string }>>`
      SELECT id FROM products WHERE id = ${productId}
    `;
    expect(remainingProducts).toEqual([]);

    const remainingLinks = await sql<Array<{ product_id: string }>>`
      SELECT product_id::text AS product_id FROM product_categories
      WHERE product_id = ${productId} OR category_id IN (${parentId}, ${childId})
    `;
    expect(remainingLinks).toEqual([]);
  });
});
