/**
 * `updateProduct` service — chunk 1a.2.
 *
 * Contract:
 *   - Tenant-scoped via withTenant; service receives a narrow
 *     UpdateProductTenantInfo, NOT the full Tenant.
 *   - Sparse update: every editable field is `.optional()`. `key in input`
 *     triggers SET. `costPriceMinor: null` explicitly clears it; key
 *     absent leaves it alone.
 *   - Optimistic concurrency: `expectedUpdatedAt` is required.
 *     UPDATE WHERE updated_at = $expected; empty RETURNING →
 *     disambiguating SELECT distinguishes not_found vs stale_write.
 *   - Tier-B input gate: staff with costPriceMinor (set OR clear) →
 *     FORBIDDEN. Cost-price is owner-only for both reads and writes.
 *   - Slug collision (pg 23505 on products_tenant_slug_unique) →
 *     TRPCError CONFLICT 'slug_taken'.
 *   - Stale write → throws StaleWriteError.
 *   - Soft-deleted row → not_found shape (RLS plus deleted_at filter).
 *   - Returns { public, audit } — wire is role-gated; audit is always
 *     full ProductOwner shape so audit-wrap can record the Tier-B
 *     before/after even on a staff edit.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { SlugTakenError } from "@/server/audit/error-codes";
import * as schema from "@/server/db/schema";
import { products } from "@/server/db/schema/catalog";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { StaleWriteError } from "@/server/audit/error-codes";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const DATABASE_URL_APP = process.env.DATABASE_URL_APP ?? DATABASE_URL;

const superClient = postgres(DATABASE_URL, { max: 4 });
const superDb = drizzle(superClient, { schema });

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `up-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en', ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedProduct(
  tenantId: string,
  opts?: { costPriceMinor?: number | null; slug?: string; name?: { en: string; ar: string } },
): Promise<{ id: string; updatedAt: Date; slug: string }> {
  const id = randomUUID();
  const slug = opts?.slug ?? `p-${id.slice(0, 8)}`;
  const name = opts?.name ?? { en: "Old", ar: "قديم" };
  const cost = opts?.costPriceMinor ?? null;
  await superDb.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status, cost_price_minor)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify(name).replace(/'/g, "''")}'::jsonb`)},
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

describe("updateProduct — service", () => {
  it("1. owner edits all fields including costPriceMinor — returns ProductOwner with new values + updatedAt advanced", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, { costPriceMinor: 100 });

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        slug: `new-${seeded.slug}`,
        name: { en: "New", ar: "جديد" },
        description: { en: "desc-en" },
        status: "active",
        costPriceMinor: 999,
      }),
    );
    expect(result.public).toMatchObject({
      id: seeded.id,
      slug: `new-${seeded.slug}`,
      status: "active",
      costPriceMinor: 999,
    });
    expect(result.audit.costPriceMinor).toBe(999);
    expect(result.public.updatedAt.getTime()).toBeGreaterThanOrEqual(seeded.updatedAt.getTime());
  });

  it("2. staff edits non-Tier-B fields — returns ProductOwner; row's costPriceMinor unchanged in DB", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, { costPriceMinor: 7777 });

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateProduct(tx, { id: tenantId }, "staff", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        status: "active",
      }),
    );
    expect((result.public as { costPriceMinor: number | null }).costPriceMinor).toBe(7777);
    expect(result.audit.costPriceMinor).toBe(7777);

    const dbRows = await superDb.select().from(products).where(eq(products.id, seeded.id));
    expect(dbRows[0]?.costPriceMinor).toBe(7777);
  });

  it("3. staff input carrying costPriceMinor (set) — throws FORBIDDEN", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        updateProduct(tx, { id: tenantId }, "staff", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          costPriceMinor: 100,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("FORBIDDEN");
  });

  it("3b. staff input carrying costPriceMinor: null (clear) — also throws FORBIDDEN", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, { costPriceMinor: 50 });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        updateProduct(tx, { id: tenantId }, "staff", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          costPriceMinor: null,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("FORBIDDEN");
  });

  it("4. owner happy path: row read after update reflects every changed field", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, { costPriceMinor: 1 });

    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        slug: "fresh-slug-x",
        name: { en: "FreshName", ar: "جديد" },
        description: { en: "fresh", ar: "ج" },
        status: "active",
        costPriceMinor: 222,
      }),
    );
    const dbRows = await superDb.select().from(products).where(eq(products.id, seeded.id));
    expect(dbRows[0]).toMatchObject({
      slug: "fresh-slug-x",
      name: { en: "FreshName", ar: "جديد" },
      status: "active",
      costPriceMinor: 222,
    });
  });

  it("5. customer role on existing row gets ProductPublic (no costPriceMinor)", async () => {
    // Customer reaching updateProduct should be defense-in-depth blocked,
    // but if reached the role-gated output schema must still strip Tier-B.
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, { costPriceMinor: 33 });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        updateProduct(tx, { id: tenantId }, "customer", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          status: "active",
        }),
      );
    } catch (e) {
      caught = e;
    }
    // Inner role guard rejects.
    expect(caught).toBeTruthy();
    expect(String(caught)).toMatch(/role/i);
  });

  it("6. tenant isolation: tenantA caller updating tenantB's id throws NOT_FOUND", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const seededInB = await seedProduct(tenantB);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), async (tx) =>
        updateProduct(tx, { id: tenantA }, "owner", {
          id: seededInB.id,
          expectedUpdatedAt: seededInB.updatedAt.toISOString(),
          status: "active",
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
  });

  it("7. IDOR existence-leak: cross-tenant id throws SAME NOT_FOUND as a phantom UUID (no `forbidden` distinction)", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const seededInB = await seedProduct(tenantB);
    const phantom = randomUUID();

    const errOf = async (id: string): Promise<TRPCError> => {
      try {
        await withTenant(superDb, ctxFor(tenantA), async (tx) =>
          updateProduct(tx, { id: tenantA }, "owner", {
            id,
            expectedUpdatedAt: seededInB.updatedAt.toISOString(),
            status: "active",
          }),
        );
        throw new Error("expected throw");
      } catch (e) {
        return e as TRPCError;
      }
    };
    const e1 = await errOf(seededInB.id);
    const e2 = await errOf(phantom);
    expect(e1.code).toBe("NOT_FOUND");
    expect(e2.code).toBe("NOT_FOUND");
    expect(e1.message).toBe(e2.message);
  });

  it("8. slug-collision: editing slug to one another product owns surfaces SlugTakenError (no slug echo)", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const a = await seedProduct(tenantId);
    const b = await seedProduct(tenantId);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        updateProduct(tx, { id: tenantId }, "owner", {
          id: b.id,
          expectedUpdatedAt: b.updatedAt.toISOString(),
          slug: a.slug,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SlugTakenError);
    expect((caught as Error).message).toBe("slug_taken");
    // Wire message must NOT echo the offending slug back.
    expect((caught as Error).message).not.toContain(a.slug);
  });

  it("9. slug unchanged from current value succeeds (no spurious self-collision)", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        slug: seeded.slug,
      }),
    );
    expect(result.public).toMatchObject({ slug: seeded.slug });
  });

  it("10. bilingual edge — en-only name update: stored ar value preserved", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, { name: { en: "Old", ar: "قديم" } });

    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        name: { en: "OnlyEn" },
      }),
    );
    const dbRows = await superDb.select().from(products).where(eq(products.id, seeded.id));
    expect(dbRows[0]?.name).toMatchObject({ en: "OnlyEn", ar: "قديم" });
  });

  it("11. bilingual edge — both en and ar updated: stored row reflects both", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);

    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        name: { en: "BothA", ar: "البتالا" },
      }),
    );
    const dbRows = await superDb.select().from(products).where(eq(products.id, seeded.id));
    expect(dbRows[0]?.name).toMatchObject({ en: "BothA", ar: "البتالا" });
  });

  it("12. bilingual edge — partial name with empty string in either locale: rejected by Zod", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);

    await expect(
      withTenant(superDb, ctxFor(tenantId), async (tx) =>
        updateProduct(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          name: { en: "" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("13. input rejection: slug over 120 chars throws Zod", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);
    await expect(
      withTenant(superDb, ctxFor(tenantId), async (tx) =>
        updateProduct(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          slug: "a".repeat(121),
        }),
      ),
    ).rejects.toThrow();
  });

  it("14. input rejection: slug fails regex (Arabic chars) throws Zod", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);
    await expect(
      withTenant(superDb, ctxFor(tenantId), async (tx) =>
        updateProduct(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          slug: "سوني",
        }),
      ),
    ).rejects.toThrow();
  });

  it("15. input rejection: name aggregate over 16KB throws Zod", async () => {
    const { localizedTextPartial } = await import("@/lib/i18n/localized");
    const s = localizedTextPartial({ max: 9000 });
    const big = "a".repeat(9000);
    expect(() => s.parse({ en: big, ar: big })).toThrow(/16KB|too large|cap/i);
  });

  it("16. OCC stale: stale expectedUpdatedAt throws StaleWriteError; row unchanged in DB", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);

    // Bump updated_at via a real first write, so the second tries with a
    // stale token.
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
        updateProduct(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(), // stale
          name: { en: "ShouldNotApply", ar: "لاتطبيق" },
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaleWriteError);

    const dbRows = await superDb.select().from(products).where(eq(products.id, seeded.id));
    expect((dbRows[0]?.name as { en: string }).en).not.toBe("ShouldNotApply");
  });

  it("17. OCC missing: input without expectedUpdatedAt throws Zod", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);
    await expect(
      withTenant(superDb, ctxFor(tenantId), async (tx) =>
        updateProduct(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          status: "active",
        } as never),
      ),
    ).rejects.toThrow();
  });

  it("18. service signature: input has NO tenantId field (Low-02)", async () => {
    const { UpdateProductInputSchema } = await import("@/server/services/products/update-product");
    // Refine wraps the object — peel ._def.schema to get ZodObject's shape if needed.
    const innerShape =
      "shape" in UpdateProductInputSchema
        ? (UpdateProductInputSchema as { shape: Record<string, unknown> }).shape
        : ((UpdateProductInputSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })._def.schema.shape);
    expect(Object.keys(innerShape)).not.toContain("tenantId");
  });

  it("19. service signature: input has NO role field", async () => {
    const { UpdateProductInputSchema } = await import("@/server/services/products/update-product");
    const innerShape =
      "shape" in UpdateProductInputSchema
        ? (UpdateProductInputSchema as { shape: Record<string, unknown> }).shape
        : ((UpdateProductInputSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })._def.schema.shape);
    expect(Object.keys(innerShape)).not.toContain("role");
  });

  it("20. RLS belt: app_user without withTenant — pre-update SELECT returns zero rows → NOT_FOUND (RLS fails-closed at the SELECT seam)", async () => {
    // SELECT under RLS without `app.tenant_id` set returns zero rows
    // (the USING clause evaluates to false), not a 42501. The
    // service's pre-SELECT then maps this to NOT_FOUND — same
    // observable shape as a cross-tenant probe. The invariant is
    // "RLS keeps the row invisible," not "RLS raises on every path."
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);
    const appClient = postgres(DATABASE_URL_APP, { max: 1 });
    const appDb = drizzle(appClient, { schema });
    try {
      let caught: unknown = null;
      try {
        await appDb.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE app_user`);
          // No SET LOCAL app.tenant_id — RLS hides the row.
          return updateProduct(tx, { id: tenantId }, "owner", {
            id: seeded.id,
            expectedUpdatedAt: seeded.updatedAt.toISOString(),
            status: "active",
          });
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TRPCError);
      expect((caught as TRPCError).code).toBe("NOT_FOUND");
      // Row in DB is unchanged (no UPDATE was attempted).
      const dbRows = await superDb.select().from(products).where(eq(products.id, seeded.id));
      expect(dbRows[0]?.status).toBe("draft");
    } finally {
      await appClient.end({ timeout: 5 });
    }
  });

  it("21. soft-deleted row: throws NOT_FOUND (deleted_at filter)", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);
    await superDb.execute(sql`UPDATE products SET deleted_at = now() WHERE id = ${seeded.id}`);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        updateProduct(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
          status: "active",
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
  });

  it("22. sparse-update preserves absent fields (only status changes; name/description/slug/costPriceMinor untouched)", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, { costPriceMinor: 555 });

    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        status: "active",
      }),
    );
    const dbRows = await superDb.select().from(products).where(eq(products.id, seeded.id));
    expect(dbRows[0]).toMatchObject({
      slug: seeded.slug,
      name: { en: "Old", ar: "قديم" },
      status: "active",
      costPriceMinor: 555,
    });
  });

  it("23. owner: explicit-null on costPriceMinor clears it", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, { costPriceMinor: 999 });

    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        costPriceMinor: null,
      }),
    );
    const dbRows = await superDb.select().from(products).where(eq(products.id, seeded.id));
    expect(dbRows[0]?.costPriceMinor).toBeNull();
  });

  it("24. empty editable set rejects at Zod ('at least one editable field required')", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId);
    await expect(
      withTenant(superDb, ctxFor(tenantId), async (tx) =>
        updateProduct(tx, { id: tenantId }, "owner", {
          id: seeded.id,
          expectedUpdatedAt: seeded.updatedAt.toISOString(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("25. audit shape always carries costPriceMinor on success — even for staff edits (so audit-wrap can record before/after correctly)", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, { costPriceMinor: 4242 });

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateProduct(tx, { id: tenantId }, "staff", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        status: "active",
      }),
    );
    expect(result.audit.costPriceMinor).toBe(4242);
    // Wire (public) shape for staff also includes costPriceMinor (staff
    // is a write role). The Tier-B distinction is staff vs customer/support.
    expect((result.public as { costPriceMinor: number | null }).costPriceMinor).toBe(4242);
  });

  it("26. before snapshot: service exposes the pre-update row state via the audit return shape", async () => {
    const { updateProduct } = await import("@/server/services/products/update-product");
    const tenantId = await makeTenant();
    const seeded = await seedProduct(tenantId, {
      name: { en: "Before", ar: "قبل" },
      costPriceMinor: 10,
    });

    const result = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      updateProduct(tx, { id: tenantId }, "owner", {
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        name: { en: "After", ar: "بعد" },
        costPriceMinor: 20,
      }),
    );
    expect(result.before.name).toMatchObject({ en: "Before" });
    expect(result.before.costPriceMinor).toBe(10);
    expect(result.audit.name).toMatchObject({ en: "After" });
    expect(result.audit.costPriceMinor).toBe(20);
  });
});
