/**
 * `hardDeleteExpiredProducts` sweeper service — chunk 1a.3 Block 3.
 *
 * Owner-only (NOT isWriteRole — tighter than delete/restore because the
 * op is bulk + irreversible). dryRun returns a preview without deleting;
 * non-dryRun DELETEs rows whose `deletedAt` is older than 30 days under
 * the caller's tenant only (M4 — never cross-tenant).
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { products } from "@/server/db/schema/catalog";
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
  const slug = `swp-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedDeleted(
  tenantId: string,
  daysAgo: number,
  slugTag = "p",
): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `${slugTag}-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status, deleted_at)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)},
      'draft', now() - (${daysAgo}::int || ' days')::interval)
  `);
  return { id, slug };
}

async function seedLive(tenantId: string): Promise<string> {
  const id = randomUUID();
  const slug = `live-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "L", ar: "ح" })}'::jsonb`)}, 'draft')
  `);
  return id;
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("hardDeleteExpiredProducts — sweeper service", () => {
  it("dryRun: returns count + ids + slugs without deleting", async () => {
    const { hardDeleteExpiredProducts } = await import(
      "@/server/services/products/hard-delete-expired-products"
    );
    const tenantId = await makeTenant();
    const a = await seedDeleted(tenantId, 31);
    const b = await seedDeleted(tenantId, 35);
    const live = await seedLive(tenantId);
    const fresh = await seedDeleted(tenantId, 5); // inside window

    const out = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredProducts(tx, { id: tenantId }, "owner", {
        dryRun: true,
        confirm: true,
      }),
    );
    expect(out.dryRun).toBe(true);
    expect(out.count).toBe(2);
    expect(out.ids.sort()).toEqual([a.id, b.id].sort());
    expect(out.slugs?.sort()).toEqual([a.slug, b.slug].sort());

    // Nothing actually deleted.
    const remaining = await superDb
      .select({ id: products.id })
      .from(products)
      .where(eq(products.tenantId, tenantId));
    expect(remaining.length).toBe(4);
    // Live + fresh-deleted are untouched explicitly.
    const stillThere = remaining.map((r) => r.id);
    expect(stillThere).toContain(a.id);
    expect(stillThere).toContain(b.id);
    expect(stillThere).toContain(live);
    expect(stillThere).toContain(fresh.id);
  });

  it("non-dryRun: deletes only expired rows (>30d); inside-window and live untouched", async () => {
    const { hardDeleteExpiredProducts } = await import(
      "@/server/services/products/hard-delete-expired-products"
    );
    const tenantId = await makeTenant();
    const expired = await seedDeleted(tenantId, 35);
    const fresh = await seedDeleted(tenantId, 10);
    const live = await seedLive(tenantId);

    const out = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredProducts(tx, { id: tenantId }, "owner", {
        dryRun: false,
        confirm: true,
      }),
    );
    expect(out.dryRun).toBe(false);
    expect(out.count).toBe(1);
    expect(out.ids).toEqual([expired.id]);
    // M3: non-dryRun result must NOT carry slugs.
    expect(out.slugs).toBeUndefined();

    const remainingIds = (
      await superDb
        .select({ id: products.id })
        .from(products)
        .where(eq(products.tenantId, tenantId))
    ).map((r) => r.id);
    expect(remainingIds).not.toContain(expired.id);
    expect(remainingIds).toContain(fresh.id);
    expect(remainingIds).toContain(live);
  });

  it("window cutoff math: row at 29d23h is KEPT; row at 30d1h is PURGED", async () => {
    const { hardDeleteExpiredProducts } = await import(
      "@/server/services/products/hard-delete-expired-products"
    );
    const tenantId = await makeTenant();
    const inside = randomUUID();
    const outside = randomUUID();
    await superDb.execute(sql`
      INSERT INTO products (id, tenant_id, slug, name, status, deleted_at)
      VALUES (${inside}, ${tenantId}, ${"in-" + inside.slice(0, 6)},
        ${sql.raw(`'${JSON.stringify({ en: "in", ar: "ا" })}'::jsonb`)},
        'draft', now() - interval '29 days 23 hours')
    `);
    await superDb.execute(sql`
      INSERT INTO products (id, tenant_id, slug, name, status, deleted_at)
      VALUES (${outside}, ${tenantId}, ${"out-" + outside.slice(0, 6)},
        ${sql.raw(`'${JSON.stringify({ en: "out", ar: "خ" })}'::jsonb`)},
        'draft', now() - interval '30 days 1 hour')
    `);

    const out = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredProducts(tx, { id: tenantId }, "owner", {
        dryRun: false,
        confirm: true,
      }),
    );
    expect(out.count).toBe(1);
    expect(out.ids).toEqual([outside]);

    const remainingIds = (
      await superDb
        .select({ id: products.id })
        .from(products)
        .where(eq(products.tenantId, tenantId))
    ).map((r) => r.id);
    expect(remainingIds).toContain(inside);
    expect(remainingIds).not.toContain(outside);
  });

  it("M4 cross-tenant: tenant A's sweeper does not touch tenant B's expired-deleted rows", async () => {
    const { hardDeleteExpiredProducts } = await import(
      "@/server/services/products/hard-delete-expired-products"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const inA = await seedDeleted(tenantA, 35);
    const inB = await seedDeleted(tenantB, 35);

    const out = await withTenant(superDb, ctxFor(tenantA), async (tx) =>
      hardDeleteExpiredProducts(tx, { id: tenantA }, "owner", {
        dryRun: false,
        confirm: true,
      }),
    );
    expect(out.count).toBe(1);
    expect(out.ids).toEqual([inA.id]);

    // Tenant B's row UNCHANGED.
    const stillInB = await superDb
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, inB.id));
    expect(stillInB.length).toBe(1);
  });

  it("owner-only: staff role rejected", async () => {
    const { hardDeleteExpiredProducts } = await import(
      "@/server/services/products/hard-delete-expired-products"
    );
    const tenantId = await makeTenant();
    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        hardDeleteExpiredProducts(tx, { id: tenantId }, "staff", {
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

  it("Zod gate: confirm absent or false rejects (even with dryRun:true)", async () => {
    const { HardDeleteExpiredProductsInputSchema } = await import(
      "@/server/services/products/hard-delete-expired-products"
    );
    expect(
      HardDeleteExpiredProductsInputSchema.safeParse({ dryRun: true }).success,
    ).toBe(false);
    expect(
      HardDeleteExpiredProductsInputSchema.safeParse({
        dryRun: true,
        confirm: false,
      }).success,
    ).toBe(false);
    expect(
      HardDeleteExpiredProductsInputSchema.safeParse({
        confirm: true,
      }).success,
    ).toBe(true);
  });

  it("service signature: input has NO tenantId/role fields", async () => {
    const { HardDeleteExpiredProductsInputSchema } = await import(
      "@/server/services/products/hard-delete-expired-products"
    );
    const shape = (
      HardDeleteExpiredProductsInputSchema as { shape: Record<string, unknown> }
    ).shape;
    expect(Object.keys(shape)).not.toContain("tenantId");
    expect(Object.keys(shape)).not.toContain("role");
  });

  it("ids cap: with >50 expired rows, ids array is capped at 50; count is total", async () => {
    const { hardDeleteExpiredProducts } = await import(
      "@/server/services/products/hard-delete-expired-products"
    );
    const tenantId = await makeTenant();
    // Bulk-insert 55 expired rows.
    for (let i = 0; i < 55; i++) {
      await seedDeleted(tenantId, 35, `bulk${i}`);
    }
    const dry = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredProducts(tx, { id: tenantId }, "owner", {
        dryRun: true,
        confirm: true,
      }),
    );
    expect(dry.count).toBe(55);
    expect(dry.ids.length).toBe(50);
    expect(dry.slugs?.length).toBe(50);

    const real = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredProducts(tx, { id: tenantId }, "owner", {
        dryRun: false,
        confirm: true,
      }),
    );
    expect(real.count).toBe(55);
    expect(real.ids.length).toBe(50);
    expect(real.slugs).toBeUndefined();
  });
});
