/**
 * `restoreProduct` service — chunk 1a.3 Block 2.
 *
 * Restores a soft-deleted row (`deletedAt = NULL`) within the 30-day
 * recovery window. Asymmetric to delete:
 *   - No `expectedUpdatedAt` — deleted rows aren't editable; OCC theatre.
 *   - Recovery window is enforced at the DB seam — older than 30 days
 *     throws RestoreWindowExpiredError.
 *   - Slug collision-during-window: pg 23505 → SlugTakenError.
 *   - tenantId comes from the authenticated context, NEVER from input
 *     (M2(a) — security must-fix).
 *   - Cross-tenant: NOT_FOUND with no shape leak (M2(b) — IDOR-safe).
 *   - Returns { before, audit } both as full ProductOwner shapes.
 *     `audit.deletedAt` is null post-restore (M1).
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import * as schema from "@/server/db/schema";
import { products } from "@/server/db/schema/catalog";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { RestoreWindowExpiredError } from "@/server/audit/error-codes";

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
  const slug = `rst-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedDeletedProduct(
  tenantId: string,
  opts?: {
    costPriceMinor?: number | null;
    slug?: string;
    deletedDaysAgo?: number;
  },
): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = opts?.slug ?? `p-${id.slice(0, 8)}`;
  const cost = opts?.costPriceMinor ?? null;
  const days = opts?.deletedDaysAgo ?? 0;
  await superDb.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status, cost_price_minor, deleted_at)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" }).replace(/'/g, "''")}'::jsonb`)},
      'draft', ${cost}, now() - (${days}::int || ' days')::interval)
  `);
  return { id, slug };
}

async function seedLiveProduct(
  tenantId: string,
  slug: string,
): Promise<string> {
  const id = randomUUID();
  await superDb.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "Live", ar: "ح" }).replace(/'/g, "''")}'::jsonb`)},
      'draft')
  `);
  return id;
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("restoreProduct — service", () => {
  it("happy path: row restored within window, audit.deletedAt is null", async () => {
    const { restoreProduct } = await import(
      "@/server/services/products/restore-product"
    );
    const tenantId = await makeTenant();
    const seeded = await seedDeletedProduct(tenantId, {
      costPriceMinor: 4242,
      deletedDaysAgo: 5,
    });

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      restoreProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        confirm: true,
      }),
    );

    expect(result.before.deletedAt).toBeInstanceOf(Date);
    expect(result.before.costPriceMinor).toBe(4242);
    expect(result.audit.deletedAt).toBeNull();
    expect(result.audit.costPriceMinor).toBe(4242);
    expect(result.audit.id).toBe(seeded.id);

    const dbRows = await superDb
      .select({ deletedAt: products.deletedAt })
      .from(products)
      .where(eq(products.id, seeded.id));
    expect(dbRows[0]?.deletedAt).toBeNull();
  });

  it("recovery window expired: deletedAt > 30 days ago throws RestoreWindowExpiredError", async () => {
    const { restoreProduct } = await import(
      "@/server/services/products/restore-product"
    );
    const tenantId = await makeTenant();
    const seeded = await seedDeletedProduct(tenantId, { deletedDaysAgo: 31 });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        restoreProduct(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RestoreWindowExpiredError);

    // Row still soft-deleted (no UPDATE happened).
    const dbRows = await superDb
      .select({ deletedAt: products.deletedAt })
      .from(products)
      .where(eq(products.id, seeded.id));
    expect(dbRows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("never-deleted row: NOT_FOUND with same shape as phantom UUID", async () => {
    const { restoreProduct } = await import(
      "@/server/services/products/restore-product"
    );
    const tenantId = await makeTenant();
    const liveId = await seedLiveProduct(tenantId, `live-${randomUUID().slice(0, 6)}`);
    const phantom = randomUUID();

    const errOf = async (id: string): Promise<TRPCError> => {
      try {
        await withTenant(superDb, ctxFor(tenantId), async (tx) =>
          restoreProduct(tx, { id: tenantId }, "owner", {
            id,
            confirm: true,
          }),
        );
        throw new Error("expected throw");
      } catch (e) {
        return e as TRPCError;
      }
    };
    const e1 = await errOf(liveId);
    const e2 = await errOf(phantom);
    expect(e1.code).toBe("NOT_FOUND");
    expect(e2.code).toBe("NOT_FOUND");
    expect(e1.message).toBe(e2.message);
  });

  it("M2(b) cross-tenant: tenant A calls restore on tenant B's deleted-product id → NOT_FOUND", async () => {
    const { restoreProduct } = await import(
      "@/server/services/products/restore-product"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const inB = await seedDeletedProduct(tenantB, { deletedDaysAgo: 1 });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), async (tx) =>
        restoreProduct(tx, { id: tenantA }, "owner", {
          id: inB.id,
          confirm: true,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");

    // Tenant B's row UNCHANGED (still deleted) — actor's tenant scope held.
    const dbRows = await superDb
      .select({ deletedAt: products.deletedAt })
      .from(products)
      .where(eq(products.id, inB.id));
    expect(dbRows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("defense-in-depth: customer role rejected at the inner role guard", async () => {
    const { restoreProduct } = await import(
      "@/server/services/products/restore-product"
    );
    const tenantId = await makeTenant();
    const seeded = await seedDeletedProduct(tenantId, { deletedDaysAgo: 1 });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        restoreProduct(tx, { id: tenantId }, "customer", {
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

  it("Zod gate: missing/false confirm rejects (destructive symmetry)", async () => {
    const { RestoreProductInputSchema } = await import(
      "@/server/services/products/restore-product"
    );
    expect(
      RestoreProductInputSchema.safeParse({ id: randomUUID() }).success,
    ).toBe(false);
    expect(
      RestoreProductInputSchema.safeParse({ id: randomUUID(), confirm: false })
        .success,
    ).toBe(false);
  });

  it("staff role can restore", async () => {
    const { restoreProduct } = await import(
      "@/server/services/products/restore-product"
    );
    const tenantId = await makeTenant();
    const seeded = await seedDeletedProduct(tenantId, {
      costPriceMinor: 999,
      deletedDaysAgo: 2,
    });

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      restoreProduct(tx, { id: tenantId }, "staff", {
        id: seeded.id,
        confirm: true,
      }),
    );
    expect(result.audit.deletedAt).toBeNull();
    // Audit shape always carries Tier-B regardless of caller role.
    expect(result.audit.costPriceMinor).toBe(999);
  });

  it("service signature: input has NO tenantId/role/expectedUpdatedAt fields", async () => {
    const { RestoreProductInputSchema } = await import(
      "@/server/services/products/restore-product"
    );
    const shape = (
      RestoreProductInputSchema as { shape: Record<string, unknown> }
    ).shape;
    expect(Object.keys(shape)).not.toContain("tenantId");
    expect(Object.keys(shape)).not.toContain("role");
    expect(Object.keys(shape)).not.toContain("expectedUpdatedAt");
  });

  it("at-the-cutoff: deletedAt at exactly the 30-day boundary is restorable", async () => {
    // 29 days, 23 hours, 59 minutes — comfortably inside.
    const { restoreProduct } = await import(
      "@/server/services/products/restore-product"
    );
    const tenantId = await makeTenant();
    const id = randomUUID();
    const slug = `bnd-${id.slice(0, 8)}`;
    await superDb.execute(sql`
      INSERT INTO products (id, tenant_id, slug, name, status, deleted_at)
      VALUES (${id}, ${tenantId}, ${slug},
        ${sql.raw(`'${JSON.stringify({ en: "B", ar: "ب" })}'::jsonb`)},
        'draft', now() - interval '29 days 23 hours 59 minutes')
    `);

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      restoreProduct(tx, { id: tenantId }, "owner", { id, confirm: true }),
    );
    expect(result.audit.deletedAt).toBeNull();
  });
});
