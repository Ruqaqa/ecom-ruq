/**
 * `listCategories` service — chunk 1a.4.1.
 *
 * Contract:
 *   - Tenant-scoped read via withTenant.
 *   - Flat output. Each item carries parentId + computed depth.
 *   - No pagination (bounded tree, depth ≤ 3).
 *   - Sort:
 *       includeDeleted=false → parent_id NULLS FIRST, position ASC,
 *                              name->>(default_locale) ASC, id ASC.
 *       includeDeleted=true  → deleted rows first (by deleted_at DESC),
 *                              then live rows in the live sort order.
 *   - Inner role guard: owner+staff. (No anonymous storefront category
 *     listing in this chunk; that lands when the storefront does.)
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
  const slug = `cat-list-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedCategory(
  tenantId: string,
  opts: {
    id?: string;
    slug?: string;
    name?: { en: string; ar: string };
    parentId?: string | null;
    position?: number;
    deletedAt?: Date | null;
  } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  const slug = opts.slug ?? `c-${id.slice(0, 8)}`;
  const name = opts.name ?? { en: "Cat", ar: "ت" };
  const parentId = opts.parentId ?? null;
  await superDb.execute(sql`
    INSERT INTO categories (id, tenant_id, slug, name, parent_id, position, deleted_at)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify(name).replace(/'/g, "''")}'::jsonb`)},
      ${parentId},
      ${opts.position ?? 0},
      ${opts.deletedAt ? opts.deletedAt.toISOString() : null})
  `);
  return id;
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("listCategories — service", () => {
  it("empty tenant: returns empty items array", async () => {
    const { listCategories } = await import(
      "@/server/services/categories/list-categories"
    );
    const tenantId = await makeTenant();
    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listCategories(tx, { id: tenantId, defaultLocale: "en" }, "owner", {}),
    );
    expect(out.items).toEqual([]);
  });

  it("flat output with computed depth: roots get depth=1, children depth=2, grandchildren depth=3", async () => {
    const { listCategories } = await import(
      "@/server/services/categories/list-categories"
    );
    const tenantId = await makeTenant();
    const root = await seedCategory(tenantId, { name: { en: "A", ar: "أ" } });
    const child = await seedCategory(tenantId, {
      parentId: root,
      name: { en: "AA", ar: "أأ" },
    });
    await seedCategory(tenantId, {
      parentId: child,
      name: { en: "AAA", ar: "أأأ" },
    });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listCategories(tx, { id: tenantId, defaultLocale: "en" }, "owner", {}),
    );
    expect(out.items.length).toBe(3);
    const byName: Record<string, number> = {};
    for (const item of out.items) {
      byName[item.name.en] = item.depth;
    }
    expect(byName.A).toBe(1);
    expect(byName.AA).toBe(2);
    expect(byName.AAA).toBe(3);
  });

  it("default sort (live only): parent_id NULLS FIRST, then position ASC, then name asc", async () => {
    const { listCategories } = await import(
      "@/server/services/categories/list-categories"
    );
    const tenantId = await makeTenant();
    const rootB = await seedCategory(tenantId, {
      name: { en: "B", ar: "ب" },
      position: 1,
    });
    const rootA = await seedCategory(tenantId, {
      name: { en: "A", ar: "أ" },
      position: 0,
    });
    // Children of rootA + rootB. Roots come first because parent_id NULLS FIRST.
    await seedCategory(tenantId, {
      parentId: rootA,
      name: { en: "Aa", ar: "أأ" },
    });
    await seedCategory(tenantId, {
      parentId: rootB,
      name: { en: "Ba", ar: "بب" },
    });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listCategories(tx, { id: tenantId, defaultLocale: "en" }, "owner", {}),
    );
    const order = out.items.map((c) => c.name.en);
    // Roots first (NULLS FIRST), in position order — A (pos 0), then B (pos 1).
    expect(order.slice(0, 2)).toEqual(["A", "B"]);
    expect(order.includes("Aa")).toBe(true);
    expect(order.includes("Ba")).toBe(true);
    // [A, B] ahead of [Aa, Ba].
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("Aa"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("Ba"));
  });

  it("includeDeleted=true: deleted rows appear first (most-recently-removed at top), then live rows", async () => {
    const { listCategories } = await import(
      "@/server/services/categories/list-categories"
    );
    const tenantId = await makeTenant();
    await seedCategory(tenantId, { name: { en: "Alive", ar: "ح" } });
    await superDb.execute(sql`
      INSERT INTO categories (id, tenant_id, slug, name, deleted_at)
      VALUES (${randomUUID()}, ${tenantId}, ${"old-removed-" + randomUUID().slice(0, 8)},
        ${sql.raw(`'${JSON.stringify({ en: "OldRemoved", ar: "ق" })}'::jsonb`)},
        now() - interval '2 hours')
    `);
    await superDb.execute(sql`
      INSERT INTO categories (id, tenant_id, slug, name, deleted_at)
      VALUES (${randomUUID()}, ${tenantId}, ${"new-removed-" + randomUUID().slice(0, 8)},
        ${sql.raw(`'${JSON.stringify({ en: "NewRemoved", ar: "ج" })}'::jsonb`)},
        now() - interval '30 minutes')
    `);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listCategories(tx, { id: tenantId, defaultLocale: "en" }, "owner", { includeDeleted: true }),
    );
    const names = out.items.map((c) => c.name.en);
    expect(names).toEqual(["NewRemoved", "OldRemoved", "Alive"]);
  });

  it("includeDeleted=false (default) excludes soft-deleted rows", async () => {
    const { listCategories } = await import(
      "@/server/services/categories/list-categories"
    );
    const tenantId = await makeTenant();
    await seedCategory(tenantId, { name: { en: "Alive", ar: "ح" } });
    await seedCategory(tenantId, {
      name: { en: "Removed", ar: "م" },
      deletedAt: new Date(),
    });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listCategories(tx, { id: tenantId, defaultLocale: "en" }, "owner", {}),
    );
    const names = out.items.map((c) => c.name.en);
    expect(names).toEqual(["Alive"]);
  });

  it("inner role guard: customer rejected", async () => {
    const { listCategories } = await import(
      "@/server/services/categories/list-categories"
    );
    const tenantId = await makeTenant();
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        listCategories(tx, { id: tenantId, defaultLocale: "en" }, "customer", {}),
      ),
    ).rejects.toThrow(/role/i);
  });

  it("staff role allowed (write role)", async () => {
    const { listCategories } = await import(
      "@/server/services/categories/list-categories"
    );
    const tenantId = await makeTenant();
    await seedCategory(tenantId);
    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      listCategories(tx, { id: tenantId, defaultLocale: "en" }, "staff", {}),
    );
    expect(out.items.length).toBe(1);
  });

  it("tenant isolation: rows in tenant B do NOT appear in tenant A's list", async () => {
    const { listCategories } = await import(
      "@/server/services/categories/list-categories"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    await seedCategory(tenantA, { name: { en: "A-row", ar: "أ" } });
    await seedCategory(tenantB, { name: { en: "B-row", ar: "ب" } });

    const out = await withTenant(superDb, ctxFor(tenantA), (tx) =>
      listCategories(tx, { id: tenantA, defaultLocale: "en" }, "owner", {}),
    );
    const names = out.items.map((c) => c.name.en);
    expect(names).toContain("A-row");
    expect(names).not.toContain("B-row");
  });

  it("input schema has NO tenantId or role fields", async () => {
    const { ListCategoriesInputSchema } = await import(
      "@/server/services/categories/list-categories"
    );
    const keys = Object.keys(ListCategoriesInputSchema.shape);
    expect(keys).not.toContain("tenantId");
    expect(keys).not.toContain("role");
  });
});
