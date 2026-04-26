/**
 * `deleteProduct` service — chunk 1a.3 Block 1.
 *
 * Soft-delete semantics:
 *   - SET deleted_at = now(), updated_at = now() WHERE id, tenant_id,
 *     deleted_at IS NULL, OCC matches.
 *   - 0 rows affected disambiguates: gone → NOT_FOUND, exists with
 *     advanced updated_at → StaleWriteError.
 *   - Defense-in-depth role guard inside service (isWriteRole).
 *   - Idempotent re-delete REJECTS with NOT_FOUND (not silent success):
 *     the row is invisible past the deleted_at filter, same shape as
 *     "row never existed."
 *   - Returns { before, audit } both as full ProductOwner shapes.
 *     `audit.deletedAt` is populated (M1 — full owner shape post-delete).
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
import { StaleWriteError } from "@/server/audit/error-codes";

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
  const slug = `del-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedProduct(
  tenantId: string,
  opts?: { costPriceMinor?: number | null; slug?: string },
): Promise<{ id: string; slug: string; updatedAt: Date }> {
  const id = randomUUID();
  const slug = opts?.slug ?? `p-${id.slice(0, 8)}`;
  const cost = opts?.costPriceMinor ?? null;
  await superDb.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status, cost_price_minor)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" }).replace(/'/g, "''")}'::jsonb`)},
      'draft', ${cost})
  `);
  const rows = await superDb
    .select({ updatedAt: products.updatedAt })
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  return { id, slug, updatedAt: rows[0]!.updatedAt };
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("deleteProduct — service", () => {
  it("happy path: soft-deletes the row; before/audit shapes are full ProductOwner with deletedAt populated", async () => {
    const { deleteProduct } = await import(
      "@/server/services/products/delete-product"
    );
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, { costPriceMinor: 4242 });

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      deleteProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: true,
      }),
    );

    expect(result.before).toMatchObject({
      id: seeded.id,
      slug: seeded.slug,
      status: "draft",
      costPriceMinor: 4242,
    });
    expect(result.before.deletedAt).toBeNull();
    expect(result.audit).toMatchObject({
      id: seeded.id,
      slug: seeded.slug,
      status: "draft",
      costPriceMinor: 4242,
    });
    expect(result.audit.deletedAt).toBeInstanceOf(Date);

    const dbRows = await superDb
      .select({ deletedAt: products.deletedAt })
      .from(products)
      .where(eq(products.id, seeded.id));
    expect(dbRows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("OCC stale: throws StaleWriteError; row's deletedAt remains null", async () => {
    const { deleteProduct } = await import(
      "@/server/services/products/delete-product"
    );
    const { updateProduct } = await import(
      "@/server/services/products/update-product"
    );
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);

    // Bump updated_at via a real update so the cached token is stale.
    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        status: "active",
      }),
    );

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        deleteProduct(tx, { id: tenantId }, "owner", {
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
      .select({ deletedAt: products.deletedAt })
      .from(products)
      .where(eq(products.id, seeded.id));
    expect(dbRows[0]?.deletedAt).toBeNull();
  });

  it("cross-tenant id: NOT_FOUND with same shape as a phantom UUID (IDOR safe)", async () => {
    const { deleteProduct } = await import(
      "@/server/services/products/delete-product"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const inB = await seedProduct(tenantB);
    const phantom = randomUUID();

    const errOf = async (id: string): Promise<TRPCError> => {
      try {
        await withTenant(superDb, ctxFor(tenantA), async (tx) =>
          deleteProduct(tx, { id: tenantA }, "owner", {
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
    expect(e1.code).toBe("NOT_FOUND");
    expect(e2.code).toBe("NOT_FOUND");
    expect(e1.message).toBe(e2.message);
  });

  it("idempotency: re-deleting an already-deleted row throws NOT_FOUND (not silent success)", async () => {
    const { deleteProduct } = await import(
      "@/server/services/products/delete-product"
    );
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);
    // First delete OK.
    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      deleteProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: true,
      }),
    );

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        deleteProduct(tx, { id: tenantId }, "owner", {
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

  it("defense-in-depth: customer role rejected at the inner role guard", async () => {
    const { deleteProduct } = await import(
      "@/server/services/products/delete-product"
    );
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        deleteProduct(tx, { id: tenantId }, "customer", {
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

  it("Zod gate: missing confirm rejects (destructive op invariant)", async () => {
    const { deleteProduct, DeleteProductInputSchema } = await import(
      "@/server/services/products/delete-product"
    );
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);

    // Schema-level — `confirm: z.literal(true)` rejects absence/false.
    const r = DeleteProductInputSchema.safeParse({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
    });
    expect(r.success).toBe(false);
    const r2 = DeleteProductInputSchema.safeParse({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      confirm: false,
    });
    expect(r2.success).toBe(false);
    // Bypassed at the runtime call too.
    await expect(
      withTenant(superDb, ctxFor(tenantId), async (tx) =>
        deleteProduct(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
        } as never),
      ),
    ).rejects.toThrow();
  });

  it("staff role can delete (write-role gate)", async () => {
    const { deleteProduct } = await import(
      "@/server/services/products/delete-product"
    );
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, { costPriceMinor: 12 });
    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      deleteProduct(tx, { id: tenantId }, "staff", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: true,
      }),
    );
    expect(result.audit.deletedAt).toBeInstanceOf(Date);
    // Audit shape always carries Tier-B regardless of caller role.
    expect(result.audit.costPriceMinor).toBe(12);
    expect(result.before.costPriceMinor).toBe(12);
  });

  it("service signature: input has NO tenantId field", async () => {
    const { DeleteProductInputSchema } = await import(
      "@/server/services/products/delete-product"
    );
    const shape = (DeleteProductInputSchema as { shape: Record<string, unknown> })
      .shape;
    expect(Object.keys(shape)).not.toContain("tenantId");
    expect(Object.keys(shape)).not.toContain("role");
  });
});
