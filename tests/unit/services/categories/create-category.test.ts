/**
 * `createCategory` service — chunk 1a.4.1.
 *
 * Mirrors the products contract:
 *   - Tenant-scoped via withTenant; service receives a narrow tenant info.
 *   - Latin slug shape (slugSchema), uniqueness within tenant via partial
 *     unique index on (tenant_id, slug) WHERE deleted_at IS NULL.
 *   - Bilingual name required (both locales). Description optional, partial.
 *   - parent_id optional; if set, must exist in tenant + not soft-deleted.
 *     Depth cap = 3 (parent must be at depth ≤ 2). Roots are depth 1.
 *   - Slug collision against a LIVE row → SlugTakenError (reuse the
 *     products' error class).
 *   - Slug collision against a SOFT-DELETED row → succeeds (partial index).
 *   - Inner role guard (defense-in-depth) — owner+staff only.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import * as schema from "@/server/db/schema";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { SlugTakenError } from "@/server/audit/error-codes";

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
  const slug = `cat-create-${id.slice(0, 8)}`;
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
): Promise<string> {
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
  return id;
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

function goodInput() {
  return {
    slug: `cat-${randomUUID().slice(0, 8)}`,
    name: { en: "Cameras", ar: "كاميرات" },
  };
}

describe("createCategory — service", () => {
  it("happy path (root): owner creates a depth-1 category — output has parentId=null, depth=1", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createCategory(tx, { id: tenantId }, "owner", goodInput()),
    );

    expect(out).toMatchObject({
      parentId: null,
      depth: 1,
      position: 0,
      name: { en: "Cameras", ar: "كاميرات" },
    });
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("depth-2: child of a root succeeds; output has parentId set + depth=2", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    const root = await seedCategory(tenantId);

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createCategory(tx, { id: tenantId }, "owner", {
        ...goodInput(),
        parentId: root,
      }),
    );
    expect(out.parentId).toBe(root);
    expect(out.depth).toBe(2);
  });

  it("depth-3: grandchild of a root succeeds; output has depth=3", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    const root = await seedCategory(tenantId);
    const child = await seedCategory(tenantId, { parentId: root });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createCategory(tx, { id: tenantId }, "owner", {
        ...goodInput(),
        parentId: child,
      }),
    );
    expect(out.depth).toBe(3);
  });

  it("depth-4 rejected: child of a depth-3 throws BAD_REQUEST 'category_depth_exceeded'", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    const root = await seedCategory(tenantId);
    const child = await seedCategory(tenantId, { parentId: root });
    const grand = await seedCategory(tenantId, { parentId: child });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        createCategory(tx, { id: tenantId }, "owner", {
          ...goodInput(),
          parentId: grand,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("BAD_REQUEST");
    expect((caught as TRPCError).message).toBe("category_depth_exceeded");
  });

  it("parent in another tenant → BAD_REQUEST 'parent_not_found' (cross-tenant probe-safe)", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const parentInB = await seedCategory(tenantB);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA), (tx) =>
        createCategory(tx, { id: tenantA }, "owner", {
          ...goodInput(),
          parentId: parentInB,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("BAD_REQUEST");
    expect((caught as TRPCError).message).toBe("parent_not_found");
  });

  it("soft-deleted parent → BAD_REQUEST 'parent_not_found'", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    const root = await seedCategory(tenantId, { deletedAt: new Date() });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        createCategory(tx, { id: tenantId }, "owner", {
          ...goodInput(),
          parentId: root,
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).message).toBe("parent_not_found");
  });

  it("Zod input rejects bad slug shape (uppercase)", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        createCategory(tx, { id: tenantId }, "owner", {
          slug: "Cameras",
          name: { en: "x", ar: "x" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("Zod input rejects missing arabic name (both locales required)", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        createCategory(tx, { id: tenantId }, "owner", {
          slug: `c-${randomUUID().slice(0, 8)}`,
          name: { en: "x" } as never,
        }),
      ),
    ).rejects.toThrow();
  });

  it("slug collision (live row) → SlugTakenError; wire message is 'slug_taken' (no echo)", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    const liveSlug = `dup-${randomUUID().slice(0, 8)}`;
    await seedCategory(tenantId, { slug: liveSlug });

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantId), (tx) =>
        createCategory(tx, { id: tenantId }, "owner", {
          slug: liveSlug,
          name: { en: "x", ar: "س" },
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SlugTakenError);
    expect((caught as Error).message).toBe("slug_taken");
    expect((caught as Error).message).not.toContain(liveSlug);
  });

  it("slug collision against a SOFT-DELETED row succeeds (partial unique index allows it)", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    const dupSlug = `dupd-${randomUUID().slice(0, 8)}`;
    await seedCategory(tenantId, { slug: dupSlug, deletedAt: new Date() });

    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createCategory(tx, { id: tenantId }, "owner", {
        slug: dupSlug,
        name: { en: "Reborn", ar: "ج" },
      }),
    );
    expect(out.parentId).toBeNull();
  });

  it("same slug different tenant: succeeds (per-tenant uniqueness only)", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const sharedSlug = `shared-${randomUUID().slice(0, 8)}`;
    await seedCategory(tenantA, { slug: sharedSlug });

    const out = await withTenant(superDb, ctxFor(tenantB), (tx) =>
      createCategory(tx, { id: tenantB }, "owner", {
        slug: sharedSlug,
        name: { en: "B", ar: "ب" },
      }),
    );
    expect(out).toBeTruthy();
  });

  it("inner role guard: customer rejected (defense-in-depth)", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    await expect(
      withTenant(superDb, ctxFor(tenantId), (tx) =>
        createCategory(tx, { id: tenantId }, "customer", goodInput()),
      ),
    ).rejects.toThrow(/role/i);
  });

  it("staff allowed (write role)", async () => {
    const { createCategory } = await import(
      "@/server/services/categories/create-category"
    );
    const tenantId = await makeTenant();
    const out = await withTenant(superDb, ctxFor(tenantId), (tx) =>
      createCategory(tx, { id: tenantId }, "staff", goodInput()),
    );
    expect(out).toBeTruthy();
  });

  it("input schema has NO tenantId field (Low-02 invariant)", async () => {
    const { CreateCategoryInputSchema } = await import(
      "@/server/services/categories/create-category"
    );
    expect(Object.keys(CreateCategoryInputSchema.shape)).not.toContain(
      "tenantId",
    );
  });

  it("input schema has NO role field", async () => {
    const { CreateCategoryInputSchema } = await import(
      "@/server/services/categories/create-category"
    );
    expect(Object.keys(CreateCategoryInputSchema.shape)).not.toContain("role");
  });
});
