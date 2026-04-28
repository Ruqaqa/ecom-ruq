/**
 * `moveCategory` service — 1a.4.2 follow-up.
 *
 * Mirrors the createCategory / updateCategory test shape:
 *   - Real Postgres tx via withTenant; per-test makeTenant for isolation.
 *   - seedCategory helper builds named live rows with explicit positions.
 *
 * Coverage:
 *   1. Happy path swap up: middle row moves earlier; positions swap.
 *   2. Happy path swap down: middle row moves later; positions swap.
 *   3. First row's "up" is a no-op (idempotent at the edge).
 *   4. Last row's "down" is a no-op (idempotent at the edge).
 *   5. Cross-tenant id → NOT_FOUND (existence-leak guard).
 *   6. Customer role → throws "role not permitted" (defense-in-depth gate).
 *   7. Soft-deleted subject → NOT_FOUND.
 *   8. Tie-break: equal-position siblings move deterministically without
 *      shuffling the whole group.
 *   9. Concurrency note (no OCC token): two move calls compose
 *      sequentially; the architectural choice to skip OCC is documented in
 *      move-category.ts. We exercise the back-and-forth composition here
 *      to assert the "idempotent re-tap to undo" UX contract.
 *  10. Reorder is parent-aware: a row's siblings are scoped by parent_id,
 *      so a move does not touch rows under a different parent.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import * as schema from "@/server/db/schema";
import { categories } from "@/server/db/schema/catalog";
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
  const slug = `cat-mv-${id.slice(0, 8)}`;
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
    position?: number;
    deletedAt?: Date | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const slug = opts.slug ?? `c-${id.slice(0, 8)}`;
  const name = opts.name ?? { en: "Cat", ar: "ت" };
  const parentId = opts.parentId ?? null;
  const position = opts.position ?? 0;
  await superDb.execute(sql`
    INSERT INTO categories (id, tenant_id, slug, name, parent_id, position, deleted_at)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify(name).replace(/'/g, "''")}'::jsonb`)},
      ${parentId},
      ${position},
      ${opts.deletedAt ? opts.deletedAt.toISOString() : null})
  `);
  return id;
}

async function readPositions(ids: string[]): Promise<Map<string, number>> {
  const rows = await superDb
    .select({ id: categories.id, position: categories.position })
    .from(categories);
  const out = new Map<string, number>();
  for (const r of rows) {
    if (ids.includes(r.id)) out.set(r.id, r.position);
  }
  return out;
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("moveCategory — service", () => {
  it("swap up: middle row moves earlier; positions swap with predecessor", async () => {
    const { moveCategory } = await import(
      "@/server/services/categories/move-category"
    );
    const tenantId = await makeTenant();
    const a = await seedCategory(tenantId, {
      name: { en: "A", ar: "أ" },
      position: 0,
    });
    const b = await seedCategory(tenantId, {
      name: { en: "B", ar: "ب" },
      position: 1,
    });
    const c = await seedCategory(tenantId, {
      name: { en: "C", ar: "س" },
      position: 2,
    });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      moveCategory(tx, { id: tenantId }, "owner", { id: b, direction: "up" }),
    );

    expect(out.noop).toBe(false);
    const positions = await readPositions([a, b, c]);
    // After swap: A(1), B(0), C(2). B is now first in render order.
    expect(positions.get(a)).toBe(1);
    expect(positions.get(b)).toBe(0);
    expect(positions.get(c)).toBe(2);
  });

  it("swap down: middle row moves later; positions swap with successor", async () => {
    const { moveCategory } = await import(
      "@/server/services/categories/move-category"
    );
    const tenantId = await makeTenant();
    const a = await seedCategory(tenantId, {
      name: { en: "A", ar: "أ" },
      position: 0,
    });
    const b = await seedCategory(tenantId, {
      name: { en: "B", ar: "ب" },
      position: 1,
    });
    const c = await seedCategory(tenantId, {
      name: { en: "C", ar: "س" },
      position: 2,
    });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      moveCategory(tx, { id: tenantId }, "owner", { id: b, direction: "down" }),
    );

    expect(out.noop).toBe(false);
    const positions = await readPositions([a, b, c]);
    expect(positions.get(a)).toBe(0);
    expect(positions.get(b)).toBe(2);
    expect(positions.get(c)).toBe(1);
  });

  it("first row's up is an idempotent no-op (positions unchanged)", async () => {
    const { moveCategory } = await import(
      "@/server/services/categories/move-category"
    );
    const tenantId = await makeTenant();
    const a = await seedCategory(tenantId, {
      name: { en: "A", ar: "أ" },
      position: 0,
    });
    const b = await seedCategory(tenantId, {
      name: { en: "B", ar: "ب" },
      position: 1,
    });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      moveCategory(tx, { id: tenantId }, "owner", { id: a, direction: "up" }),
    );

    expect(out.noop).toBe(true);
    const positions = await readPositions([a, b]);
    expect(positions.get(a)).toBe(0);
    expect(positions.get(b)).toBe(1);
  });

  it("last row's down is an idempotent no-op (positions unchanged)", async () => {
    const { moveCategory } = await import(
      "@/server/services/categories/move-category"
    );
    const tenantId = await makeTenant();
    const a = await seedCategory(tenantId, {
      name: { en: "A", ar: "أ" },
      position: 0,
    });
    const b = await seedCategory(tenantId, {
      name: { en: "B", ar: "ب" },
      position: 1,
    });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      moveCategory(tx, { id: tenantId }, "owner", { id: b, direction: "down" }),
    );

    expect(out.noop).toBe(true);
    const positions = await readPositions([a, b]);
    expect(positions.get(a)).toBe(0);
    expect(positions.get(b)).toBe(1);
  });

  it("cross-tenant id → NOT_FOUND (existence-leak guard)", async () => {
    const { moveCategory } = await import(
      "@/server/services/categories/move-category"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const inB = await seedCategory(tenantB);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), (tx) =>
        moveCategory(tx, { id: tenantA }, "owner", {
          id: inB,
          direction: "up",
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
  });

  it("customer role → throws (defense-in-depth gate)", async () => {
    const { moveCategory } = await import(
      "@/server/services/categories/move-category"
    );
    const tenantId = await makeTenant();
    const a = await seedCategory(tenantId);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        moveCategory(tx, { id: tenantId }, "customer", {
          id: a,
          direction: "up",
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/role not permitted/);
  });

  it("soft-deleted subject id → NOT_FOUND", async () => {
    const { moveCategory } = await import(
      "@/server/services/categories/move-category"
    );
    const tenantId = await makeTenant();
    const a = await seedCategory(tenantId, { deletedAt: new Date() });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        moveCategory(tx, { id: tenantId }, "owner", {
          id: a,
          direction: "up",
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
  });

  it("tie-break: equal positions resolve deterministically by name then id", async () => {
    const { moveCategory } = await import(
      "@/server/services/categories/move-category"
    );
    const tenantId = await makeTenant();
    // Three siblings, all at position 0. Sibling order by name->>'en':
    // A, B, C → ids[0]=A, ids[1]=B, ids[2]=C in render order.
    const a = await seedCategory(tenantId, {
      name: { en: "A", ar: "أ" },
      position: 0,
    });
    const b = await seedCategory(tenantId, {
      name: { en: "B", ar: "ب" },
      position: 0,
    });
    const c = await seedCategory(tenantId, {
      name: { en: "C", ar: "س" },
      position: 0,
    });

    // Move B up: B should land at position -1 (one slot before A's
    // position, A unchanged). A and C unchanged.
    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      moveCategory(tx, { id: tenantId }, "owner", { id: b, direction: "up" }),
    );
    expect(out.noop).toBe(false);

    const positions = await readPositions([a, b, c]);
    expect(positions.get(b)).toBe(-1);
    expect(positions.get(a)).toBe(0);
    expect(positions.get(c)).toBe(0);
  });

  it("composition: tap up then tap down on the same row returns to the original order", async () => {
    const { moveCategory } = await import(
      "@/server/services/categories/move-category"
    );
    const tenantId = await makeTenant();
    const a = await seedCategory(tenantId, {
      name: { en: "A", ar: "أ" },
      position: 0,
    });
    const b = await seedCategory(tenantId, {
      name: { en: "B", ar: "ب" },
      position: 1,
    });
    const cId = await seedCategory(tenantId, {
      name: { en: "C", ar: "س" },
      position: 2,
    });

    await withTenant(superDb, ctxFor(tenantId), (tx) =>
      moveCategory(tx, { id: tenantId }, "owner", { id: b, direction: "up" }),
    );
    // After: A(1), B(0), C(2)
    await withTenant(superDb, ctxFor(tenantId), (tx) =>
      moveCategory(tx, { id: tenantId }, "owner", { id: b, direction: "down" }),
    );
    // After: A(0), B(1), C(2)
    const positions = await readPositions([a, b, cId]);
    expect(positions.get(a)).toBe(0);
    expect(positions.get(b)).toBe(1);
    expect(positions.get(cId)).toBe(2);
  });

  it("parent-aware: moving a row in group X does not touch rows in group Y", async () => {
    const { moveCategory } = await import(
      "@/server/services/categories/move-category"
    );
    const tenantId = await makeTenant();
    // Two roots → two separate sibling groups.
    const root1 = await seedCategory(tenantId, {
      name: { en: "R1", ar: "أ" },
    });
    const root2 = await seedCategory(tenantId, {
      name: { en: "R2", ar: "ب" },
    });
    // Children under root1.
    const x1 = await seedCategory(tenantId, {
      name: { en: "X1", ar: "ج" },
      parentId: root1,
      position: 0,
    });
    const x2 = await seedCategory(tenantId, {
      name: { en: "X2", ar: "د" },
      parentId: root1,
      position: 1,
    });
    // Children under root2 — at the same positions.
    const y1 = await seedCategory(tenantId, {
      name: { en: "Y1", ar: "ه" },
      parentId: root2,
      position: 0,
    });
    const y2 = await seedCategory(tenantId, {
      name: { en: "Y2", ar: "و" },
      parentId: root2,
      position: 1,
    });

    await withTenant(superDb, ctxFor(tenantId), (tx) =>
      moveCategory(tx, { id: tenantId }, "owner", { id: x2, direction: "up" }),
    );

    const positions = await readPositions([x1, x2, y1, y2]);
    // X group swapped.
    expect(positions.get(x1)).toBe(1);
    expect(positions.get(x2)).toBe(0);
    // Y group untouched.
    expect(positions.get(y1)).toBe(0);
    expect(positions.get(y2)).toBe(1);
  });
});

describe("moveCategory — invariants for the new createCategory default", () => {
  it("createCategory without explicit position lands at max(siblings)+1", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    // Seed two existing roots at positions 0 and 7 (gap is fine — we
    // anchor on MAX, not COUNT).
    await seedCategory(tenantId, {
      name: { en: "Existing-A", ar: "أ" },
      position: 0,
    });
    await seedCategory(tenantId, {
      name: { en: "Existing-B", ar: "ب" },
      position: 7,
    });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createCategory(tx, { id: tenantId }, "owner", {
        slug: `c-${randomUUID().slice(0, 8)}`,
        name: { en: "Newcomer", ar: "ج" },
      }),
    );
    expect(out.position).toBe(8);
  });

  it("createCategory with explicit position honours the value (MCP back-compat)", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createCategory(tx, { id: tenantId }, "owner", {
        slug: `c-${randomUUID().slice(0, 8)}`,
        name: { en: "Pinned", ar: "ث" },
        position: 42,
      }),
    );
    expect(out.position).toBe(42);
  });

  it("createCategory under empty parent group lands at position 0", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    const root = await seedCategory(tenantId);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createCategory(tx, { id: tenantId }, "owner", {
        slug: `c-${randomUUID().slice(0, 8)}`,
        name: { en: "FirstChild", ar: "أ" },
        parentId: root,
      }),
    );
    expect(out.position).toBe(0);
  });
});
