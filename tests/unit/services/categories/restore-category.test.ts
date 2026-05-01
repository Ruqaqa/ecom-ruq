/**
 * `restoreCategory` service — chunk 1a.4.3 Block 2.
 *
 * Single-row restore (NEVER subtree). Mirrors `restoreProduct`:
 *   - No `expectedUpdatedAt` (deleted rows aren't editable; OCC theatre).
 *   - Per-tenant `pg_advisory_xact_lock('categories_tree:' || tenantId)`
 *     taken first so concurrent re-parents/deletes/restores serialize.
 *   - 30-day window enforced at the DB seam — older rows surface
 *     `RestoreWindowExpiredError`.
 *   - Parent-still-removed guard: if the row's `parent_id` is non-null
 *     and that parent's `deleted_at IS NOT NULL`, refuse with
 *     BAD_REQUEST `parent_still_removed`.
 *   - Slug-collision guard: pg 23505 on the partial unique index
 *     `categories_tenant_slug_unique_live` → `SlugTakenError`.
 *   - Depth re-check: recompute live ancestry depth and reject
 *     `category_depth_exceeded` if it now exceeds 3.
 *   - Restoring an already-live row → NOT_FOUND.
 *   - Cross-tenant id → NOT_FOUND (IDOR-safe).
 *   - Single-row only: restoring a parent does NOT restore descendants.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq, inArray, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import * as schema from "@/server/db/schema";
import { categories } from "@/server/db/schema/catalog";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import {
  RestoreWindowExpiredError,
  SlugTakenError,
} from "@/server/audit/error-codes";

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
  const slug = `e2e-cat-rst-${id.slice(0, 8)}`;
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

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("restoreCategory — service", () => {
  it("happy path: row restored within window, after.deletedAt is null", async () => {
    const { restoreCategory } = await import(
      "@/server/services/categories/restore-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId, { deletedDaysAgo: 5 });

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      restoreCategory(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        confirm: true,
      }),
    );
    expect(result.before.deletedAt).toBeInstanceOf(Date);
    expect(result.after.deletedAt).toBeNull();
    expect(result.after.id).toBe(seeded.id);

    const dbRows = await superDb
      .select({ deletedAt: categories.deletedAt })
      .from(categories)
      .where(eq(categories.id, seeded.id));
    expect(dbRows[0]?.deletedAt).toBeNull();
  });

  it("parent-still-removed: refuses with BAD_REQUEST 'parent_still_removed'; row stays removed", async () => {
    const { restoreCategory } = await import(
      "@/server/services/categories/restore-category"
    );
    const tenantId = await makeTenant();
    const parent = await seedCategory(tenantId, { deletedDaysAgo: 1 });
    const child = await seedCategory(tenantId, {
      parentId: parent.id,
      deletedDaysAgo: 1,
    });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        restoreCategory(tx, { id: tenantId }, "owner", {
          id: child.id,
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("BAD_REQUEST");
    expect((caught as TRPCError).message).toBe("parent_still_removed");

    // Child stays removed.
    const dbRows = await superDb
      .select({ deletedAt: categories.deletedAt })
      .from(categories)
      .where(eq(categories.id, child.id));
    expect(dbRows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("restore-after-parent-restore: restoring parent first, then child both succeed", async () => {
    const { restoreCategory } = await import(
      "@/server/services/categories/restore-category"
    );
    const tenantId = await makeTenant();
    const parent = await seedCategory(tenantId, { deletedDaysAgo: 1 });
    const child = await seedCategory(tenantId, {
      parentId: parent.id,
      deletedDaysAgo: 1,
    });

    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      restoreCategory(tx, { id: tenantId }, "owner", {
        id: parent.id,
        confirm: true,
      }),
    );
    const out = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      restoreCategory(tx, { id: tenantId }, "owner", {
        id: child.id,
        confirm: true,
      }),
    );
    expect(out.after.deletedAt).toBeNull();
  });

  it("recovery window expired: deletedAt > 30 days throws RestoreWindowExpiredError", async () => {
    const { restoreCategory } = await import(
      "@/server/services/categories/restore-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId, { deletedDaysAgo: 31 });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        restoreCategory(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RestoreWindowExpiredError);

    const dbRows = await superDb
      .select({ deletedAt: categories.deletedAt })
      .from(categories)
      .where(eq(categories.id, seeded.id));
    expect(dbRows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("slug collision on restore: while target removed a new live row takes its slug → SlugTakenError; row stays removed", async () => {
    const { restoreCategory } = await import(
      "@/server/services/categories/restore-category"
    );
    const tenantId = await makeTenant();
    const dupSlug = `e2e-dup-${randomUUID().slice(0, 8)}`;
    // Seed a removed row that owns the slug.
    const removed = await seedCategory(tenantId, {
      slug: dupSlug,
      deletedDaysAgo: 2,
    });
    // While it's removed, the partial unique index allows a new live row
    // to take the same slug (this is exactly what we want to catch on
    // restore).
    await seedCategory(tenantId, { slug: dupSlug });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        restoreCategory(tx, { id: tenantId }, "owner", {
          id: removed.id,
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SlugTakenError);

    // Row stays removed — no half-restored state.
    const dbRows = await superDb
      .select({ deletedAt: categories.deletedAt })
      .from(categories)
      .where(eq(categories.id, removed.id));
    expect(dbRows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("depth re-check on restore: live ancestry exceeds 3 → BAD_REQUEST 'category_depth_exceeded'", async () => {
    const { restoreCategory } = await import(
      "@/server/services/categories/restore-category"
    );
    const tenantId = await makeTenant();
    // Build a 3-deep live tree: root → child → grand. While `target`
    // (the row we'll restore) was removed, its parent has been moved
    // under `grand` so a live restore would land it at depth 4.
    const root = await seedCategory(tenantId);
    const child = await seedCategory(tenantId, { parentId: root.id });
    const grand = await seedCategory(tenantId, { parentId: child.id });

    // `target` is currently removed; when seeded its parent was `root`
    // (depth 2 at delete time). Now re-parent its (live) parent under
    // `grand` so a restore would land target at depth 4.
    const targetParent = await seedCategory(tenantId, { parentId: root.id });
    const target = await seedCategory(tenantId, {
      parentId: targetParent.id,
      deletedDaysAgo: 1,
    });
    // Move targetParent under grand (depth 3) → target would become
    // depth 4 if restored.
    await superDb.execute(
      sql`UPDATE categories SET parent_id = ${grand.id} WHERE id = ${targetParent.id}`,
    );

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        restoreCategory(tx, { id: tenantId }, "owner", {
          id: target.id,
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("BAD_REQUEST");
    expect((caught as TRPCError).message).toBe("category_depth_exceeded");
  });

  it("never-deleted (live) row: NOT_FOUND with same shape as phantom UUID", async () => {
    const { restoreCategory } = await import(
      "@/server/services/categories/restore-category"
    );
    const tenantId = await makeTenant();
    const live = await seedCategory(tenantId);
    const phantom = randomUUID();

    const errOf = async (id: string): Promise<TRPCError> => {
      try {
        await withTenant(superDb, ctxFor(tenantId), async (tx) =>
          restoreCategory(tx, { id: tenantId }, "owner", {
            id,
            confirm: true,
          }),
        );
        throw new Error("expected throw");
      } catch (e) {
        return e as TRPCError;
      }
    };
    const e1 = await errOf(live.id);
    const e2 = await errOf(phantom);
    expect(e1.code).toBe("NOT_FOUND");
    expect(e2.code).toBe("NOT_FOUND");
    expect(e1.message).toBe(e2.message);
  });

  it("cross-tenant id: tenant A operator with tenant B's removed-row id → NOT_FOUND; tenant B row unchanged", async () => {
    const { restoreCategory } = await import(
      "@/server/services/categories/restore-category"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const inB = await seedCategory(tenantB, { deletedDaysAgo: 1 });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), async (tx) =>
        restoreCategory(tx, { id: tenantA }, "owner", {
          id: inB.id,
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");

    const dbRows = await superDb
      .select({ deletedAt: categories.deletedAt })
      .from(categories)
      .where(eq(categories.id, inB.id));
    expect(dbRows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("single-row only: restoring a parent does NOT restore its still-removed descendants", async () => {
    const { restoreCategory } = await import(
      "@/server/services/categories/restore-category"
    );
    const tenantId = await makeTenant();
    const parent = await seedCategory(tenantId, { deletedDaysAgo: 1 });
    const child = await seedCategory(tenantId, {
      parentId: parent.id,
      deletedDaysAgo: 1,
    });
    const grand = await seedCategory(tenantId, {
      parentId: child.id,
      deletedDaysAgo: 1,
    });

    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      restoreCategory(tx, { id: tenantId }, "owner", {
        id: parent.id,
        confirm: true,
      }),
    );

    const dbRows = await superDb
      .select({ id: categories.id, deletedAt: categories.deletedAt })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, tenantId),
          inArray(categories.id, [parent.id, child.id, grand.id]),
        ),
      );
    const byId = new Map(dbRows.map((r) => [r.id, r.deletedAt]));
    expect(byId.get(parent.id)).toBeNull();
    // Descendants STILL removed — single-row restore.
    expect(byId.get(child.id)).toBeInstanceOf(Date);
    expect(byId.get(grand.id)).toBeInstanceOf(Date);
  });

  it("Zod gate: missing/false confirm rejected at schema level", async () => {
    const { RestoreCategoryInputSchema } = await import(
      "@/server/services/categories/restore-category"
    );
    expect(
      RestoreCategoryInputSchema.safeParse({ id: randomUUID() }).success,
    ).toBe(false);
    expect(
      RestoreCategoryInputSchema.safeParse({
        id: randomUUID(),
        confirm: false,
      }).success,
    ).toBe(false);
    expect(
      RestoreCategoryInputSchema.safeParse({
        id: randomUUID(),
        confirm: true,
      }).success,
    ).toBe(true);
  });

  it("inner role guard: customer rejected (defense-in-depth)", async () => {
    const { restoreCategory } = await import(
      "@/server/services/categories/restore-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId, { deletedDaysAgo: 1 });
    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        restoreCategory(tx, { id: tenantId }, "customer", {
          id: seeded.id,
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(String(caught)).toMatch(/role/i);
  });

  it("staff role can restore (write-role gate)", async () => {
    const { restoreCategory } = await import(
      "@/server/services/categories/restore-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId, { deletedDaysAgo: 2 });
    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      restoreCategory(tx, { id: tenantId }, "staff", {
        id: seeded.id,
        confirm: true,
      }),
    );
    expect(result.after.deletedAt).toBeNull();
  });

  it("input schema has NO tenantId / role / expectedUpdatedAt fields", async () => {
    const { RestoreCategoryInputSchema } = await import(
      "@/server/services/categories/restore-category"
    );
    const shape = (
      RestoreCategoryInputSchema as { shape: Record<string, unknown> }
    ).shape;
    expect(Object.keys(shape)).not.toContain("tenantId");
    expect(Object.keys(shape)).not.toContain("role");
    expect(Object.keys(shape)).not.toContain("expectedUpdatedAt");
  });
});
