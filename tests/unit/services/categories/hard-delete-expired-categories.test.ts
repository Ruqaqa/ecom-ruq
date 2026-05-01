/**
 * `hardDeleteExpiredCategories` sweeper service — chunk 1a.4.3 Block 3.
 *
 * Owner-only — bulk + irreversible (FK cascade purges descendants AND
 * `product_categories` join rows). Tighter than delete/restore which are
 * owner+staff. Owner-only is BOTH a runtime defense-in-depth check AND
 * the transport-level gate.
 *
 * Cascade-safety predicate (locked, "cautious" policy):
 *   Exclude any category from the purge set whose subtree contains a
 *   still-soft descendant whose `deleted_at` is *less than* 30 days old
 *   (i.e., still in its recovery window). The descendant is still
 *   user-restorable; if the parent were hard-deleted now, the
 *   ON DELETE CASCADE would wipe the descendant too — silently ending
 *   the descendant's recovery window. So the parent waits.
 *
 * dryRun returns ids without deleting; non-dryRun DELETEs the eligible
 * rows. FK cascade physically removes `product_categories` join rows for
 * any purged category.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq, inArray, and } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { categories, products, productCategories } from "@/server/db/schema/catalog";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const superClient = postgres(DATABASE_URL, { max: 6 });
const superDb = drizzle(superClient, { schema });

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `e2e-cat-swp-${id.slice(0, 8)}`;
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
    slug?: string;
    parentId?: string | null;
    deletedDaysAgo?: number | null;
  } = {},
): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = opts.slug ?? `e2e-c-${id.slice(0, 8)}`;
  const parentId = opts.parentId ?? null;
  const days = opts.deletedDaysAgo;
  if (typeof days === "number") {
    await superDb.execute(sql`
      INSERT INTO categories (id, tenant_id, slug, name, parent_id, deleted_at)
      VALUES (${id}, ${tenantId}, ${slug},
        ${sql.raw(`'${JSON.stringify({ en: "C", ar: "ت" })}'::jsonb`)},
        ${parentId},
        now() - (${days}::int || ' days')::interval)
    `);
  } else {
    await superDb.execute(sql`
      INSERT INTO categories (id, tenant_id, slug, name, parent_id)
      VALUES (${id}, ${tenantId}, ${slug},
        ${sql.raw(`'${JSON.stringify({ en: "C", ar: "ت" })}'::jsonb`)},
        ${parentId})
    `);
  }
  return { id, slug };
}

async function seedProduct(tenantId: string): Promise<string> {
  const id = randomUUID();
  const slug = `e2e-p-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)}, 'draft')
  `);
  return id;
}

async function linkProductToCategory(
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

describe("hardDeleteExpiredCategories — sweeper service", () => {
  it("happy path: rows older than 30 days are physically deleted; rows younger are untouched", async () => {
    const { hardDeleteExpiredCategories } = await import(
      "@/server/services/categories/hard-delete-expired-categories"
    );
    const tenantId = await makeTenant();
    const expired = await seedCategory(tenantId, { deletedDaysAgo: 35 });
    const fresh = await seedCategory(tenantId, { deletedDaysAgo: 5 });
    const live = await seedCategory(tenantId);

    const out = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredCategories(tx, { id: tenantId }, "owner", {
        dryRun: false,
        confirm: true,
      }),
    );
    expect(out.dryRun).toBe(false);
    expect(out.count).toBe(1);
    expect(out.ids).toEqual([expired.id]);

    const remaining = (
      await superDb
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.tenantId, tenantId))
    ).map((r) => r.id);
    expect(remaining).not.toContain(expired.id);
    expect(remaining).toContain(fresh.id);
    expect(remaining).toContain(live.id);
  });

  it("dryRun:true returns the would-be-purged ids without deleting; a follow-up real run still works", async () => {
    const { hardDeleteExpiredCategories } = await import(
      "@/server/services/categories/hard-delete-expired-categories"
    );
    const tenantId = await makeTenant();
    const a = await seedCategory(tenantId, { deletedDaysAgo: 31 });
    const b = await seedCategory(tenantId, { deletedDaysAgo: 35 });

    const dry = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredCategories(tx, { id: tenantId }, "owner", {
        dryRun: true,
        confirm: true,
      }),
    );
    expect(dry.dryRun).toBe(true);
    expect(dry.count).toBe(2);
    expect(dry.ids.sort()).toEqual([a.id, b.id].sort());

    // Nothing actually deleted.
    const beforeReal = (
      await superDb
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.tenantId, tenantId))
    ).map((r) => r.id);
    expect(beforeReal.sort()).toEqual([a.id, b.id].sort());

    // Real run still works.
    const real = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredCategories(tx, { id: tenantId }, "owner", {
        dryRun: false,
        confirm: true,
      }),
    );
    expect(real.count).toBe(2);

    const afterReal = (
      await superDb
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.tenantId, tenantId))
    ).map((r) => r.id);
    expect(afterReal.length).toBe(0);
  });

  it("owner-only runtime gate: staff role rejected", async () => {
    const { hardDeleteExpiredCategories } = await import(
      "@/server/services/categories/hard-delete-expired-categories"
    );
    const tenantId = await makeTenant();
    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        hardDeleteExpiredCategories(tx, { id: tenantId }, "staff", {
          dryRun: true,
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(String(caught)).toMatch(/owner-only|role/i);
  });

  it("Zod gate: missing/false confirm rejected even with dryRun:true", async () => {
    const { HardDeleteExpiredCategoriesInputSchema } = await import(
      "@/server/services/categories/hard-delete-expired-categories"
    );
    expect(
      HardDeleteExpiredCategoriesInputSchema.safeParse({ dryRun: true })
        .success,
    ).toBe(false);
    expect(
      HardDeleteExpiredCategoriesInputSchema.safeParse({
        dryRun: true,
        confirm: false,
      }).success,
    ).toBe(false);
    expect(
      HardDeleteExpiredCategoriesInputSchema.safeParse({ confirm: true })
        .success,
    ).toBe(true);
  });

  it("cascade-safety: parent expired (>30d) whose subtree has a young (<30d) soft descendant is EXCLUDED from purge", async () => {
    const { hardDeleteExpiredCategories } = await import(
      "@/server/services/categories/hard-delete-expired-categories"
    );
    const tenantId = await makeTenant();
    // Parent removed 35 days ago; child also removed but only 5 days
    // ago → child still in recovery window. Parent must NOT be purged
    // this run, because the FK cascade would silently end the child's
    // recovery window.
    const parent = await seedCategory(tenantId, { deletedDaysAgo: 35 });
    const child = await seedCategory(tenantId, {
      parentId: parent.id,
      deletedDaysAgo: 5,
    });
    // A separate, fully-expired sibling tree should still purge.
    const otherExpired = await seedCategory(tenantId, { deletedDaysAgo: 35 });

    const out = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredCategories(tx, { id: tenantId }, "owner", {
        dryRun: false,
        confirm: true,
      }),
    );
    expect(out.ids).toEqual([otherExpired.id]);

    const remaining = (
      await superDb
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.tenantId, tenantId))
    ).map((r) => r.id);
    expect(remaining).toContain(parent.id);
    expect(remaining).toContain(child.id);
    expect(remaining).not.toContain(otherExpired.id);
  });

  it("cascade-safety follow-up: after the young descendant ages out, the parent becomes eligible", async () => {
    const { hardDeleteExpiredCategories } = await import(
      "@/server/services/categories/hard-delete-expired-categories"
    );
    const tenantId = await makeTenant();
    const parent = await seedCategory(tenantId, { deletedDaysAgo: 35 });
    const child = await seedCategory(tenantId, {
      parentId: parent.id,
      deletedDaysAgo: 5,
    });

    // First run — parent excluded because of young descendant.
    const first = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredCategories(tx, { id: tenantId }, "owner", {
        dryRun: false,
        confirm: true,
      }),
    );
    expect(first.count).toBe(0);

    // Age out the child past the window.
    await superDb.execute(
      sql`UPDATE categories SET deleted_at = now() - interval '32 days' WHERE id = ${child.id}`,
    );

    const second = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredCategories(tx, { id: tenantId }, "owner", {
        dryRun: false,
        confirm: true,
      }),
    );
    // Both parent and child are now eligible. Pg's ON DELETE CASCADE
    // will wipe the child too, so depending on whether the service
    // explicitly deletes both or only the parent, count varies. Assert
    // the rows are gone.
    expect(second.count).toBeGreaterThanOrEqual(1);

    const remainingIds = (
      await superDb
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(
            eq(categories.tenantId, tenantId),
            inArray(categories.id, [parent.id, child.id]),
          ),
        )
    ).map((r) => r.id);
    expect(remainingIds.length).toBe(0);
  });

  it("FK cascade physically removes product_categories join rows when a category is purged", async () => {
    const { hardDeleteExpiredCategories } = await import(
      "@/server/services/categories/hard-delete-expired-categories"
    );
    const tenantId = await makeTenant();
    const expired = await seedCategory(tenantId, { deletedDaysAgo: 35 });
    const prod = await seedProduct(tenantId);
    await linkProductToCategory(tenantId, prod, expired.id);

    // Confirm join row exists pre-sweep.
    const before = await superDb
      .select()
      .from(productCategories)
      .where(
        and(
          eq(productCategories.tenantId, tenantId),
          eq(productCategories.categoryId, expired.id),
        ),
      );
    expect(before.length).toBe(1);

    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredCategories(tx, { id: tenantId }, "owner", {
        dryRun: false,
        confirm: true,
      }),
    );

    const after = await superDb
      .select()
      .from(productCategories)
      .where(
        and(
          eq(productCategories.tenantId, tenantId),
          eq(productCategories.categoryId, expired.id),
        ),
      );
    expect(after.length).toBe(0);

    // Product itself untouched.
    const stillProduct = await superDb
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, prod));
    expect(stillProduct.length).toBe(1);
  });

  it("cross-tenant scoping: tenant B sweeper does not touch tenant A's expired rows", async () => {
    const { hardDeleteExpiredCategories } = await import(
      "@/server/services/categories/hard-delete-expired-categories"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const inA = await seedCategory(tenantA, { deletedDaysAgo: 35 });
    const inB = await seedCategory(tenantB, { deletedDaysAgo: 35 });

    const out = await withTenant(superDb, ctxFor(tenantB), async (tx) =>
      hardDeleteExpiredCategories(tx, { id: tenantB }, "owner", {
        dryRun: false,
        confirm: true,
      }),
    );
    expect(out.ids).toEqual([inB.id]);

    // Tenant A's row UNCHANGED.
    const stillInA = await superDb
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, inA.id));
    expect(stillInA.length).toBe(1);
  });

  it("input schema has NO tenantId or role field", async () => {
    const { HardDeleteExpiredCategoriesInputSchema } = await import(
      "@/server/services/categories/hard-delete-expired-categories"
    );
    const shape = (
      HardDeleteExpiredCategoriesInputSchema as {
        shape: Record<string, unknown>;
      }
    ).shape;
    expect(Object.keys(shape)).not.toContain("tenantId");
    expect(Object.keys(shape)).not.toContain("role");
  });
});
