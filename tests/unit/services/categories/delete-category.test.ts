/**
 * `deleteCategory` service — chunk 1a.4.3 Block 1.
 *
 * Soft-delete with cascade:
 *   - Sets `deleted_at = now()`, `updated_at = now()` on the target row
 *     and on every LIVE descendant in one transaction.
 *   - OCC on the target row only via `expectedUpdatedAt`. Descendants
 *     have no token; they are flipped without one.
 *   - Per-tenant `pg_advisory_xact_lock('categories_tree:' || tenantId)`
 *     taken at the top to serialize against `updateCategory` re-parents.
 *   - `product_categories` join rows are PRESERVED on soft-delete so a
 *     restore is reversible.
 *   - Idempotent re-delete REJECTS with NOT_FOUND (same shape as a
 *     phantom UUID — IDOR existence-leak guard).
 *   - Returns `{ before, after, cascadedIds }` — `cascadedIds` lists the
 *     target plus every descendant that flipped on this call.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq, and, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import * as schema from "@/server/db/schema";
import { categories, productCategories } from "@/server/db/schema/catalog";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { StaleWriteError } from "@/server/audit/error-codes";

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
  const slug = `e2e-cat-del-${id.slice(0, 8)}`;
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
    deletedAt?: Date | null;
  } = {},
): Promise<{ id: string; slug: string; updatedAt: Date }> {
  const id = randomUUID();
  const slug = opts.slug ?? `e2e-c-${id.slice(0, 8)}`;
  const parentId = opts.parentId ?? null;
  await superDb.execute(sql`
    INSERT INTO categories (id, tenant_id, slug, name, parent_id, deleted_at)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "Cat", ar: "ت" })}'::jsonb`)},
      ${parentId},
      ${opts.deletedAt ? opts.deletedAt.toISOString() : null})
  `);
  const rows = await superDb
    .select({ updatedAt: categories.updatedAt })
    .from(categories)
    .where(eq(categories.id, id))
    .limit(1);
  return { id, slug, updatedAt: rows[0]!.updatedAt };
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

describe("deleteCategory — service", () => {
  it("happy path (leaf): soft-deletes the row; before deletedAt null, after deletedAt set; cascadedIds=[id]", async () => {
    const { deleteCategory } = await import(
      "@/server/services/categories/delete-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId);

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      deleteCategory(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: true,
      }),
    );

    expect(result.before.id).toBe(seeded.id);
    expect(result.before.deletedAt).toBeNull();
    expect(result.after.id).toBe(seeded.id);
    expect(result.after.deletedAt).toBeInstanceOf(Date);
    expect(result.cascadedIds).toEqual([seeded.id]);

    const dbRows = await superDb
      .select({ deletedAt: categories.deletedAt })
      .from(categories)
      .where(eq(categories.id, seeded.id));
    expect(dbRows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("cascade (root): removing root flips root + child + grandchild in one tx; sibling-of-root untouched", async () => {
    const { deleteCategory } = await import(
      "@/server/services/categories/delete-category"
    );
    const tenantId = await makeTenant();
    const root = await seedCategory(tenantId);
    const child = await seedCategory(tenantId, { parentId: root.id });
    const grand = await seedCategory(tenantId, { parentId: child.id });
    const sibling = await seedCategory(tenantId);

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      deleteCategory(tx, { id: tenantId }, "owner", {
        id: root.id,
        expectedUpdatedAt: root.updatedAt.toISOString(),
        confirm: true,
      }),
    );

    expect(result.cascadedIds.sort()).toEqual(
      [root.id, child.id, grand.id].sort(),
    );

    const allRows = await superDb
      .select({ id: categories.id, deletedAt: categories.deletedAt })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, tenantId),
          inArray(categories.id, [root.id, child.id, grand.id, sibling.id]),
        ),
      );
    const byId = new Map(allRows.map((r) => [r.id, r.deletedAt]));
    expect(byId.get(root.id)).toBeInstanceOf(Date);
    expect(byId.get(child.id)).toBeInstanceOf(Date);
    expect(byId.get(grand.id)).toBeInstanceOf(Date);
    // Sibling untouched.
    expect(byId.get(sibling.id)).toBeNull();
  });

  it("cascade (mid-tree): removing the child flips child + grandchild; root and sibling-of-child untouched", async () => {
    const { deleteCategory } = await import(
      "@/server/services/categories/delete-category"
    );
    const tenantId = await makeTenant();
    const root = await seedCategory(tenantId);
    const child = await seedCategory(tenantId, { parentId: root.id });
    const grand = await seedCategory(tenantId, { parentId: child.id });
    const siblingOfChild = await seedCategory(tenantId, { parentId: root.id });

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      deleteCategory(tx, { id: tenantId }, "owner", {
        id: child.id,
        expectedUpdatedAt: child.updatedAt.toISOString(),
        confirm: true,
      }),
    );
    expect(result.cascadedIds.sort()).toEqual([child.id, grand.id].sort());

    const dbRows = await superDb
      .select({ id: categories.id, deletedAt: categories.deletedAt })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, tenantId),
          inArray(categories.id, [
            root.id,
            child.id,
            grand.id,
            siblingOfChild.id,
          ]),
        ),
      );
    const byId = new Map(dbRows.map((r) => [r.id, r.deletedAt]));
    expect(byId.get(root.id)).toBeNull();
    expect(byId.get(child.id)).toBeInstanceOf(Date);
    expect(byId.get(grand.id)).toBeInstanceOf(Date);
    expect(byId.get(siblingOfChild.id)).toBeNull();
  });

  it("OCC stale: stale expectedUpdatedAt throws StaleWriteError; row still live", async () => {
    const { deleteCategory } = await import(
      "@/server/services/categories/delete-category"
    );
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId);

    // Bump updated_at via a real edit so the cached token is stale.
    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateCategory(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        position: 5,
      }),
    );

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        deleteCategory(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(), // stale
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaleWriteError);

    const dbRows = await superDb
      .select({ deletedAt: categories.deletedAt })
      .from(categories)
      .where(eq(categories.id, seeded.id));
    expect(dbRows[0]?.deletedAt).toBeNull();
  });

  it("cross-tenant id: tenant A operator with tenant B id → NOT_FOUND, same shape as phantom UUID", async () => {
    const { deleteCategory } = await import(
      "@/server/services/categories/delete-category"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const inB = await seedCategory(tenantB);
    const phantom = randomUUID();

    const errOf = async (id: string): Promise<TRPCError> => {
      try {
        await withTenant(superDb, ctxFor(tenantA), async (tx) =>
          deleteCategory(tx, { id: tenantA }, "owner", {
            id,
            expectedUpdatedAt: inB.updatedAt.toISOString(),
            confirm: true,
          }),
        );
        throw new Error("expected throw");
      } catch (e) {
        return e as TRPCError;
      }
    };
    const e1 = await errOf(inB.id);
    const e2 = await errOf(phantom);
    expect(e1).toBeInstanceOf(TRPCError);
    expect(e2).toBeInstanceOf(TRPCError);
    expect(e1.code).toBe("NOT_FOUND");
    expect(e2.code).toBe("NOT_FOUND");
    expect(e1.message).toBe(e2.message);

    // Tenant B's row UNCHANGED.
    const stillInB = await superDb
      .select({ deletedAt: categories.deletedAt })
      .from(categories)
      .where(eq(categories.id, inB.id));
    expect(stillInB[0]?.deletedAt).toBeNull();
  });

  it("idempotency: re-deleting an already-removed row throws NOT_FOUND (not silent success)", async () => {
    const { deleteCategory } = await import(
      "@/server/services/categories/delete-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId);

    // First delete OK.
    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      deleteCategory(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: true,
      }),
    );

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        deleteCategory(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
  });

  it("already-removed descendant in fixture: cascade only flips currently-live descendants; earlier deleted_at preserved", async () => {
    const { deleteCategory } = await import(
      "@/server/services/categories/delete-category"
    );
    const tenantId = await makeTenant();
    const root = await seedCategory(tenantId);
    const child = await seedCategory(tenantId, { parentId: root.id });
    const grand = await seedCategory(tenantId, { parentId: child.id });

    // Soft-delete the grandchild first, with an explicit older date.
    const earlier = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    await superDb.execute(
      sql`UPDATE categories SET deleted_at = ${earlier.toISOString()} WHERE id = ${grand.id}`,
    );
    const grandDeletedBefore = (
      await superDb
        .select({ deletedAt: categories.deletedAt })
        .from(categories)
        .where(eq(categories.id, grand.id))
    )[0]!.deletedAt;
    expect(grandDeletedBefore).toBeInstanceOf(Date);

    // Now cascade-delete the root. Only root + child should flip; grand
    // already has its own (older) deleted_at and must NOT be reset.
    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      deleteCategory(tx, { id: tenantId }, "owner", {
        id: root.id,
        expectedUpdatedAt: root.updatedAt.toISOString(),
        confirm: true,
      }),
    );
    expect(result.cascadedIds.sort()).toEqual([root.id, child.id].sort());

    const grandAfter = (
      await superDb
        .select({ deletedAt: categories.deletedAt })
        .from(categories)
        .where(eq(categories.id, grand.id))
    )[0]!.deletedAt;
    // Grand's deleted_at unchanged (recovery window not reset).
    expect(grandAfter?.getTime()).toBe(grandDeletedBefore!.getTime());
  });

  it("product_categories rows are PRESERVED on soft-delete (link survives so restore is reversible)", async () => {
    const { deleteCategory } = await import(
      "@/server/services/categories/delete-category"
    );
    const tenantId = await makeTenant();
    const cat = await seedCategory(tenantId);
    const prod = await seedProduct(tenantId);
    await linkProductToCategory(tenantId, prod, cat.id);

    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      deleteCategory(tx, { id: tenantId }, "owner", {
        id: cat.id,
        expectedUpdatedAt: cat.updatedAt.toISOString(),
        confirm: true,
      }),
    );

    const linkRows = await superDb
      .select()
      .from(productCategories)
      .where(
        and(
          eq(productCategories.tenantId, tenantId),
          eq(productCategories.categoryId, cat.id),
        ),
      );
    expect(linkRows.length).toBe(1);
    expect(linkRows[0]?.productId).toBe(prod);
  });

  it("concurrent re-parent + delete are serialized by the per-tenant advisory lock — neither corrupts state", async () => {
    const { deleteCategory } = await import(
      "@/server/services/categories/delete-category"
    );
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    // X and Y are siblings at root. T1 re-parents X under Y.
    // T2 soft-deletes Y. With the advisory lock, exactly one wins the
    // race and the resulting state is consistent (no orphan parent
    // pointer, no half-applied cascade).
    const x = await seedCategory(tenantId);
    const y = await seedCategory(tenantId);

    const move = withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateCategory(tx, { id: tenantId }, "owner", {
        id: x.id,
        expectedUpdatedAt: x.updatedAt.toISOString(),
        parentId: y.id,
      }),
    ).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );
    const del = withTenant(superDb, ctxFor(tenantId), async (tx) =>
      deleteCategory(tx, { id: tenantId }, "owner", {
        id: y.id,
        expectedUpdatedAt: y.updatedAt.toISOString(),
        confirm: true,
      }),
    ).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );

    const results = await Promise.all([move, del]);

    // Final DB state is consistent: either Y is removed and so is its
    // current child set, or Y is live and X has been re-parented.
    const dbRows = await superDb
      .select({
        id: categories.id,
        parentId: categories.parentId,
        deletedAt: categories.deletedAt,
      })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, tenantId),
          inArray(categories.id, [x.id, y.id]),
        ),
      );
    const byId = new Map(dbRows.map((r) => [r.id, r]));
    const yRow = byId.get(y.id)!;
    const xRow = byId.get(x.id)!;

    if (yRow.deletedAt !== null) {
      // Delete won. If move also "succeeded", the cascade should have
      // flipped X with Y; if the move failed (parent vanished), X stays
      // at root and live.
      const moveSucceeded =
        results.find((r) => "ok" in r && r.ok === true && "r" in r) !==
        undefined;
      // Either way, no orphan pointing at a removed parent that's still
      // visible as live (X.deletedAt mirrors Y.deletedAt when cascade
      // included it).
      if (moveSucceeded && xRow.parentId === y.id) {
        expect(xRow.deletedAt).toBeInstanceOf(Date);
      }
    } else {
      // Delete failed — Y is still live. Move must have succeeded.
      expect(xRow.parentId).toBe(y.id);
      expect(xRow.deletedAt).toBeNull();
    }
  });

  it("Zod gate: missing/false confirm rejected at schema level", async () => {
    const { DeleteCategoryInputSchema } = await import(
      "@/server/services/categories/delete-category"
    );
    expect(
      DeleteCategoryInputSchema.safeParse({
        id: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
    expect(
      DeleteCategoryInputSchema.safeParse({
        id: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        confirm: false,
      }).success,
    ).toBe(false);
    expect(
      DeleteCategoryInputSchema.safeParse({
        id: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        confirm: true,
      }).success,
    ).toBe(true);
  });

  it("inner role guard: customer rejected (defense-in-depth)", async () => {
    const { deleteCategory } = await import(
      "@/server/services/categories/delete-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId);
    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        deleteCategory(tx, { id: tenantId }, "customer", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(String(caught)).toMatch(/role/i);
  });

  it("staff role can delete (write-role gate)", async () => {
    const { deleteCategory } = await import(
      "@/server/services/categories/delete-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId);
    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      deleteCategory(tx, { id: tenantId }, "staff", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: true,
      }),
    );
    expect(result.after.deletedAt).toBeInstanceOf(Date);
  });

  it("input schema has NO tenantId or role field", async () => {
    const { DeleteCategoryInputSchema } = await import(
      "@/server/services/categories/delete-category"
    );
    const shape = (
      DeleteCategoryInputSchema as { shape: Record<string, unknown> }
    ).shape;
    expect(Object.keys(shape)).not.toContain("tenantId");
    expect(Object.keys(shape)).not.toContain("role");
  });
});
