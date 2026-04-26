/**
 * Schema-level tests for the `product_categories` join table (chunk 1a.4.1).
 *
 * Coverage:
 *   - Insert + composite-PK duplicate blocked.
 *   - FK enforced (insert with phantom product_id rejected).
 *   - Cascade on product delete: removing a product clears its links.
 *   - Cascade on category delete (the same).
 *   - Tenant-scoped RLS: cross-tenant SELECT returns 0 rows; cross-tenant
 *     INSERT rejected by WITH CHECK (42501).
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const DATABASE_URL_APP = process.env.DATABASE_URL_APP ?? DATABASE_URL;

const superClient = postgres(DATABASE_URL, { max: 4 });
const superDb = drizzle(superClient, { schema });

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `pc-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedProduct(tenantId: string): Promise<string> {
  const id = randomUUID();
  const slug = `p-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)},
      'draft')
  `);
  return id;
}

async function seedCategory(tenantId: string): Promise<string> {
  const id = randomUUID();
  const slug = `c-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO categories (id, tenant_id, slug, name)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "C", ar: "ف" })}'::jsonb`)})
  `);
  return id;
}

async function countLinks(productId: string): Promise<number> {
  const rows = await superDb.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM product_categories WHERE product_id = ${productId}`,
  );
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ n: string }> }).rows ?? []);
  return parseInt(arr[0]?.n ?? "0", 10);
}

describe("product_categories — schema", () => {
  it("insert link succeeds and reads back", async () => {
    const tenantId = await makeTenant();
    const p = await seedProduct(tenantId);
    const c = await seedCategory(tenantId);
    await superDb.execute(sql`
      INSERT INTO product_categories (tenant_id, product_id, category_id)
      VALUES (${tenantId}, ${p}, ${c})
    `);
    expect(await countLinks(p)).toBe(1);
  });

  it("composite PK blocks duplicate (product_id, category_id) inserts", async () => {
    const tenantId = await makeTenant();
    const p = await seedProduct(tenantId);
    const c = await seedCategory(tenantId);
    await superDb.execute(sql`
      INSERT INTO product_categories (tenant_id, product_id, category_id)
      VALUES (${tenantId}, ${p}, ${c})
    `);
    let caught: unknown = null;
    try {
      await superDb.execute(sql`
        INSERT INTO product_categories (tenant_id, product_id, category_id)
        VALUES (${tenantId}, ${p}, ${c})
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    // Drizzle wraps the postgres-js error; the SQLSTATE lives on `.cause`.
    expect((caught as { cause?: { code?: string } }).cause?.code).toBe("23505");
  });

  it("FK rejects insert with a non-existent product_id", async () => {
    const tenantId = await makeTenant();
    const c = await seedCategory(tenantId);
    const phantomProduct = randomUUID();
    let caught: unknown = null;
    try {
      await superDb.execute(sql`
        INSERT INTO product_categories (tenant_id, product_id, category_id)
        VALUES (${tenantId}, ${phantomProduct}, ${c})
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { cause?: { code?: string } }).cause?.code).toBe("23503");
  });

  it("cascade on product delete: links to that product are removed", async () => {
    const tenantId = await makeTenant();
    const p = await seedProduct(tenantId);
    const c = await seedCategory(tenantId);
    await superDb.execute(sql`
      INSERT INTO product_categories (tenant_id, product_id, category_id)
      VALUES (${tenantId}, ${p}, ${c})
    `);
    await superDb.execute(sql`DELETE FROM products WHERE id = ${p}`);
    expect(await countLinks(p)).toBe(0);
  });

  it("RLS: cross-tenant SELECT returns 0 rows under app_user without GUC", async () => {
    const tenantId = await makeTenant();
    const p = await seedProduct(tenantId);
    const c = await seedCategory(tenantId);
    await superDb.execute(sql`
      INSERT INTO product_categories (tenant_id, product_id, category_id)
      VALUES (${tenantId}, ${p}, ${c})
    `);
    const appClient = postgres(DATABASE_URL_APP, { max: 1 });
    const appDb = drizzle(appClient, { schema });
    try {
      const out = await appDb.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        // No app.tenant_id set → policy hides every row.
        const rows = await tx.execute<{ n: string }>(
          sql`SELECT COUNT(*)::text AS n FROM product_categories`,
        );
        const arr = Array.isArray(rows)
          ? rows
          : ((rows as { rows?: Array<{ n: string }> }).rows ?? []);
        return arr[0]?.n ?? "0";
      });
      expect(out).toBe("0");
    } finally {
      await appClient.end({ timeout: 5 });
    }
  });

  it("composite FK rejects join row whose tenant_id disagrees with product/category (super-client bypasses RLS, FK is what catches it)", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const p = await seedProduct(tenantA);
    const c = await seedCategory(tenantA);
    let caught: unknown = null;
    try {
      // tenant_id claims B but product+category are in A.
      // RLS doesn't fire for the super-client; only the composite FK
      // blocks this.
      await superDb.execute(sql`
        INSERT INTO product_categories (tenant_id, product_id, category_id)
        VALUES (${tenantB}, ${p}, ${c})
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    // 23503 = foreign_key_violation.
    expect((caught as { cause?: { code?: string } }).cause?.code).toBe("23503");
  });

  it("composite FK on categories.parent_id rejects cross-tenant parent (super-client bypasses RLS, FK is what catches it)", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const parentInA = await seedCategory(tenantA);
    const childIdInB = randomUUID();
    let caught: unknown = null;
    try {
      await superDb.execute(sql`
        INSERT INTO categories (id, tenant_id, slug, name, parent_id)
        VALUES (${childIdInB}, ${tenantB}, ${"x-" + childIdInB.slice(0, 6)},
          ${sql.raw(`'${JSON.stringify({ en: "C", ar: "ف" })}'::jsonb`)},
          ${parentInA})
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { cause?: { code?: string } }).cause?.code).toBe("23503");
  });

  it("RLS: WITH CHECK rejects cross-tenant INSERT under app_user (tenant A's GUC, row claims tenant B)", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const p = await seedProduct(tenantB);
    const c = await seedCategory(tenantB);

    const appClient = postgres(DATABASE_URL_APP, { max: 1 });
    const appDb = drizzle(appClient, { schema });
    try {
      let caught: unknown = null;
      try {
        await appDb.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE app_user`);
          await tx.execute(
            sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`,
          );
          await tx.execute(sql`
            INSERT INTO product_categories (tenant_id, product_id, category_id)
            VALUES (${tenantB}, ${p}, ${c})
          `);
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeTruthy();
      // 42501 = insufficient_privilege (RLS WITH CHECK).
      expect((caught as { cause?: { code?: string } }).cause?.code).toBe(
        "42501",
      );
    } finally {
      await appClient.end({ timeout: 5 });
    }
  });
});
