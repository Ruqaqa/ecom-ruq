/**
 * `updateCategory` service — chunk 1a.4.1.
 *
 * Mirrors `updateProduct`:
 *   - Sparse update; key-in-input semantics.
 *   - Optimistic concurrency via expectedUpdatedAt
 *     (date_trunc('milliseconds', ...) pattern).
 *   - Soft-deleted row id → NOT_FOUND. Cross-tenant id → NOT_FOUND.
 *   - Slug collision against a LIVE row → SlugTakenError. Against a
 *     SOFT-DELETED row → succeeds (partial unique index).
 *   - Cycle prevention: parentId = self → category_cycle. Parent =
 *     descendant → category_cycle.
 *   - Depth check: re-parenting a subtree may not push descendants past
 *     depth 3. → category_depth_exceeded.
 *   - Parent in another tenant or soft-deleted → parent_not_found.
 *   - Returns { before, after } as full Category shapes (audit consumes).
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import * as schema from "@/server/db/schema";
import { categories } from "@/server/db/schema/catalog";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { SlugTakenError, StaleWriteError } from "@/server/audit/error-codes";

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
  const slug = `cat-up-${id.slice(0, 8)}`;
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
    name?: { en: string; ar: string };
    parentId?: string | null;
    deletedAt?: Date | null;
  } = {},
): Promise<{ id: string; slug: string; updatedAt: Date }> {
  const id = randomUUID();
  const slug = opts.slug ?? `c-${id.slice(0, 8)}`;
  const name = opts.name ?? { en: "Cat", ar: "ت" };
  const parentId = opts.parentId ?? null;
  await superDb.execute(sql`
    INSERT INTO categories (id, tenant_id, slug, name, parent_id, deleted_at)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify(name).replace(/'/g, "''")}'::jsonb`)},
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

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("updateCategory — service", () => {
  it("happy: owner renames slug + name; output before/after reflect", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      updateCategory(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        slug: `new-${seeded.slug}`,
        name: { en: "Renamed", ar: "أ" },
      }),
    );
    expect(out.before.slug).toBe(seeded.slug);
    expect(out.after.slug).toBe(`new-${seeded.slug}`);
    expect(out.after.name).toMatchObject({ en: "Renamed", ar: "أ" });
  });

  it("sparse name.en update preserves stored name.ar", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId, {
      name: { en: "Old", ar: "قديم" },
    });

    await withTenant(superDb, ctxFor(tenantId), (tx) =>
      updateCategory(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        name: { en: "OnlyEn" },
      }),
    );
    const dbRows = await superDb
      .select()
      .from(categories)
      .where(eq(categories.id, seeded.id));
    expect(dbRows[0]?.name).toMatchObject({ en: "OnlyEn", ar: "قديم" });
  });

  it("OCC stale: stale expectedUpdatedAt throws StaleWriteError", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId);

    // First successful update.
    await withTenant(superDb, ctxFor(tenantId), (tx) =>
      updateCategory(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        position: 5,
      }),
    );

    // Second with the original (stale) token.
    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        updateCategory(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          position: 9,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaleWriteError);
  });

  it("soft-deleted row id → NOT_FOUND", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId, { deletedAt: new Date() });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        updateCategory(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          position: 1,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
  });

  it("cross-tenant id → NOT_FOUND", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const seededInB = await seedCategory(tenantB);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), (tx) =>
        updateCategory(tx, { id: tenantA }, "owner", {
          id: seededInB.id,
          expectedUpdatedAt: seededInB.updatedAt.toISOString(),
          position: 1,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
  });

  it("cycle: parentId = self → BAD_REQUEST 'category_cycle'", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        updateCategory(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          parentId: seeded.id,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).message).toBe("category_cycle");
  });

  it("cycle: parentId = own descendant → 'category_cycle'", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const root = await seedCategory(tenantId);
    const child = await seedCategory(tenantId, { parentId: root.id });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        updateCategory(tx, { id: tenantId }, "owner", {
          id: root.id,
          expectedUpdatedAt: root.updatedAt.toISOString(),
          parentId: child.id,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).message).toBe("category_cycle");
  });

  it("concurrent opposite re-parents (X→Y and Y→X) cannot both succeed — advisory lock serializes, second sees fresh tree and rejects as cycle", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    // Two siblings at root. With no lock, T1 sets X.parent=Y while T2
    // sets Y.parent=X — both pre-checks pass against the pre-other
    // snapshot under READ COMMITTED, both commits, and the tree gains
    // a cycle. With the per-tenant tree-mutation advisory lock, the
    // second transaction blocks until the first commits, then re-reads
    // and detects the cycle.
    const x = await seedCategory(tenantId);
    const y = await seedCategory(tenantId);

    const move1 = withTenant(superDb, ctxFor(tenantId), (tx) =>
      updateCategory(tx, { id: tenantId }, "owner", {
        id: x.id,
        expectedUpdatedAt: x.updatedAt.toISOString(),
        parentId: y.id,
      }),
    ).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );
    const move2 = withTenant(superDb, ctxFor(tenantId), (tx) =>
      updateCategory(tx, { id: tenantId }, "owner", {
        id: y.id,
        expectedUpdatedAt: y.updatedAt.toISOString(),
        parentId: x.id,
      }),
    ).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );

    const results = await Promise.all([move1, move2]);
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const err = (failures[0] as { ok: false; e: unknown }).e;
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).message).toBe("category_cycle");

    // Final DB state must be cycle-free.
    const rows = await superDb
      .select({ id: categories.id, parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.tenantId, tenantId));
    const byId = new Map(rows.map((r) => [r.id, r.parentId]));
    expect(byId.size).toBe(2);
    const xParent = byId.get(x.id);
    const yParent = byId.get(y.id);
    // Exactly one of them was re-parented; the other still points to root.
    const reparented = [xParent === y.id, yParent === x.id].filter(Boolean).length;
    expect(reparented).toBe(1);
  });

  it("depth violation: re-parenting a depth-2 subtree under a depth-2 parent (would push grandchild to depth 4) rejects", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    // Tree A: root → child (depth 2) → grandchild (depth 3).
    const rootA = await seedCategory(tenantId);
    const childA = await seedCategory(tenantId, { parentId: rootA.id });
    await seedCategory(tenantId, { parentId: childA.id });
    // Tree B: rootB → childB (depth 2).
    const rootB = await seedCategory(tenantId);
    const childB = await seedCategory(tenantId, { parentId: rootB.id });

    // Move childA (whose subtree is 2 deep — child + grandchild) under
    // childB (depth 2). New depths: childA → 3, grandchild → 4. Reject.
    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        updateCategory(tx, { id: tenantId }, "owner", {
          id: childA.id,
          expectedUpdatedAt: childA.updatedAt.toISOString(),
          parentId: childB.id,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).message).toBe("category_depth_exceeded");
  });

  it("parent in another tenant → 'parent_not_found'", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const seededA = await seedCategory(tenantA);
    const parentInB = await seedCategory(tenantB);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), (tx) =>
        updateCategory(tx, { id: tenantA }, "owner", {
          id: seededA.id,
          expectedUpdatedAt: seededA.updatedAt.toISOString(),
          parentId: parentInB.id,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).message).toBe("parent_not_found");
  });

  it("soft-deleted parent → 'parent_not_found'", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const node = await seedCategory(tenantId);
    const dead = await seedCategory(tenantId, { deletedAt: new Date() });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        updateCategory(tx, { id: tenantId }, "owner", {
          id: node.id,
          expectedUpdatedAt: node.updatedAt.toISOString(),
          parentId: dead.id,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).message).toBe("parent_not_found");
  });

  it("slug collision against a LIVE row → SlugTakenError", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const a = await seedCategory(tenantId);
    const b = await seedCategory(tenantId);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        updateCategory(tx, { id: tenantId }, "owner", {
          id: b.id,
          expectedUpdatedAt: b.updatedAt.toISOString(),
          slug: a.slug,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SlugTakenError);
  });

  it("slug collision against a SOFT-DELETED row → succeeds (partial unique index allows it)", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const dead = await seedCategory(tenantId, { deletedAt: new Date() });
    const live = await seedCategory(tenantId);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      updateCategory(tx, { id: tenantId }, "owner", {
        id: live.id,
        expectedUpdatedAt: live.updatedAt.toISOString(),
        slug: dead.slug,
      }),
    );
    expect(out.after.slug).toBe(dead.slug);
  });

  it("inner role guard: customer rejected", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId);
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        updateCategory(tx, { id: tenantId }, "customer", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          position: 1,
        }),
      ),
    ).rejects.toThrow(/role/i);
  });

  it("staff role allowed (write role)", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId);
    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      updateCategory(tx, { id: tenantId }, "staff", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        position: 7,
      }),
    );
    expect(out.after.position).toBe(7);
  });

  it("no editable keys: rejected by Zod refine", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const seeded = await seedCategory(tenantId);
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        updateCategory(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("explicit parentId=null moves a child to root (depth becomes 1)", async () => {
    const { updateCategory } = await import(
      "@/server/services/categories/update-category"
    );
    const tenantId = await makeTenant();
    const root = await seedCategory(tenantId);
    const child = await seedCategory(tenantId, { parentId: root.id });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      updateCategory(tx, { id: tenantId }, "owner", {
        id: child.id,
        expectedUpdatedAt: child.updatedAt.toISOString(),
        parentId: null,
      }),
    );
    expect(out.after.parentId).toBeNull();
    expect(out.after.depth).toBe(1);
  });

  it("input schema has NO tenantId or role fields", async () => {
    const { UpdateCategoryInputSchema } = await import(
      "@/server/services/categories/update-category"
    );
    const innerShape =
      "shape" in UpdateCategoryInputSchema
        ? (UpdateCategoryInputSchema as { shape: Record<string, unknown> })
            .shape
        : (
            UpdateCategoryInputSchema as unknown as {
              _def: { schema: { shape: Record<string, unknown> } };
            }
          )._def.schema.shape;
    const keys = Object.keys(innerShape);
    expect(keys).not.toContain("tenantId");
    expect(keys).not.toContain("role");
  });
});
