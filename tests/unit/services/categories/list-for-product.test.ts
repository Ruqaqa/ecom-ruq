/**
 * `listCategoriesForProduct` service — chunk 1a.4.2.
 *
 * Read returns the live categories currently linked to a product, with
 * `depth` stamped (mirrors `listCategories` shape).
 *
 *   - Soft-deleted categories are filtered out (live-only).
 *   - Cross-tenant productId, missing-from-tenant productId, and
 *     malformed productId all return `{ items: [] }` — opaque, no
 *     existence-leak.
 *   - Read-only; defense-in-depth role guard rejects customer/anonymous.
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
  const slug = `lfp-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" })}'::jsonb`)}, 'active')
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

async function seedCategory(
  tenantId: string,
  opts: { parentId?: string | null; deletedAt?: Date | null } = {},
): Promise<string> {
  const id = randomUUID();
  const slug = `c-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO categories (id, tenant_id, slug, name, parent_id, deleted_at)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "C", ar: "ف" })}'::jsonb`)},
      ${opts.parentId ?? null},
      ${opts.deletedAt ? opts.deletedAt.toISOString() : null})
  `);
  return id;
}

async function link(
  tenantId: string,
  productId: string,
  categoryId: string,
): Promise<void> {
  await superDb.execute(sql`
    INSERT INTO product_categories (tenant_id, product_id, category_id)
    VALUES (${tenantId}, ${productId}, ${categoryId})
  `);
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("listCategoriesForProduct — service", () => {
  it("returns the live linked categories with depth stamped", async () => {
    const { listCategoriesForProduct } = await import(
      "@/server/services/categories/list-for-product"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const root = await seedCategory(tenantId);
    const child = await seedCategory(tenantId, { parentId: root });
    const grand = await seedCategory(tenantId, { parentId: child });
    await link(tenantId, product, root);
    await link(tenantId, product, child);
    await link(tenantId, product, grand);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listCategoriesForProduct(tx, { id: tenantId }, "owner", {
        productId: product,
      }),
    );

    expect(out.items).toHaveLength(3);
    const byId = new Map(out.items.map((c) => [c.id, c]));
    expect(byId.get(root)?.depth).toBe(1);
    expect(byId.get(child)?.depth).toBe(2);
    expect(byId.get(grand)?.depth).toBe(3);
  });

  it("filters out soft-deleted categories", async () => {
    const { listCategoriesForProduct } = await import(
      "@/server/services/categories/list-for-product"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const live = await seedCategory(tenantId);
    const dead = await seedCategory(tenantId, { deletedAt: new Date() });
    await link(tenantId, product, live);
    await link(tenantId, product, dead);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listCategoriesForProduct(tx, { id: tenantId }, "owner", {
        productId: product,
      }),
    );
    expect(out.items.map((c) => c.id)).toEqual([live]);
  });

  it("cross-tenant productId returns empty array (no existence leak)", async () => {
    const { listCategoriesForProduct } = await import(
      "@/server/services/categories/list-for-product"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productInB = await seedProduct(tenantB);
    const catInB = await seedCategory(tenantB);
    await link(tenantB, productInB, catInB);

    const out = await withTenant(superDb, ctxFor(tenantA), (tx) =>
      listCategoriesForProduct(tx, { id: tenantA }, "owner", {
        productId: productInB,
      }),
    );
    expect(out.items).toEqual([]);
  });

  it("phantom productId returns empty array (no existence leak)", async () => {
    const { listCategoriesForProduct } = await import(
      "@/server/services/categories/list-for-product"
    );
    const tenantId = await makeTenant();
    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listCategoriesForProduct(tx, { id: tenantId }, "owner", {
        productId: randomUUID(),
      }),
    );
    expect(out.items).toEqual([]);
  });

  it("returns empty array when product exists but has no links", async () => {
    const { listCategoriesForProduct } = await import(
      "@/server/services/categories/list-for-product"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listCategoriesForProduct(tx, { id: tenantId }, "owner", {
        productId: product,
      }),
    );
    expect(out.items).toEqual([]);
  });

  it("inner role guard: customer rejected (defense-in-depth)", async () => {
    const { listCategoriesForProduct } = await import(
      "@/server/services/categories/list-for-product"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        listCategoriesForProduct(tx, { id: tenantId }, "customer", {
          productId: product,
        }),
      ),
    ).rejects.toThrow(/role/i);
  });

  it("staff allowed (write role)", async () => {
    const { listCategoriesForProduct } = await import(
      "@/server/services/categories/list-for-product"
    );
    const tenantId = await makeTenant();
    const product = await seedProduct(tenantId);
    const c = await seedCategory(tenantId);
    await link(tenantId, product, c);
    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listCategoriesForProduct(tx, { id: tenantId }, "staff", {
        productId: product,
      }),
    );
    expect(out.items).toHaveLength(1);
  });
});
