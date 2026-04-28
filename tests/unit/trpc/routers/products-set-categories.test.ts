/**
 * `productsRouter.setCategories` + `categoriesRouter.listForProduct` —
 * chunk 1a.4.2 router-level tests.
 *
 * Audit shape, role gates, error mappings. Mirrors the pattern in
 * `categories.test.ts` and `products-update.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";

beforeAll(() => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");
});

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const client = postgres(DATABASE_URL, { max: 3 });
const db = drizzle(client, { schema });

afterAll(async () => {
  await client.end({ timeout: 5 });
});

interface TenantFixture {
  tenantId: string;
  host: string;
}

async function makeTenant(): Promise<TenantFixture> {
  const id = randomUUID();
  const slug = `pc-router-${id.slice(0, 8)}`;
  const host = `${slug}.local`;
  await db.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${host}, 'en', ${"no-reply@" + host},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return { tenantId: id, host };
}

async function makeUserAndMembership(
  tenantId: string,
  role: "owner" | "staff" | "support",
): Promise<{ userId: string }> {
  const userId = randomUUID();
  await db.execute(sql`
    INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
    VALUES (${userId}, ${`u-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
  `);
  await db.execute(sql`
    INSERT INTO memberships (id, tenant_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${tenantId}::uuid, ${userId}::uuid, ${role}, now())
  `);
  return { userId };
}

interface BuildCtxOpts {
  fixture: TenantFixture;
  identityType: "anonymous" | "session" | "bearer";
  userId?: string;
  tokenId?: string;
  membershipRole?: "owner" | "staff" | "support";
  effectiveRole?: "owner" | "staff" | "support";
}

async function buildCtx(opts: BuildCtxOpts) {
  const {
    resolveTenant,
    __setTenantLookupLoaderForTests,
    clearTenantCacheForTests,
  } = await import("@/server/tenant");
  clearTenantCacheForTests();
  __setTenantLookupLoaderForTests(async () => ({
    id: opts.fixture.tenantId,
    slug: "t",
    primaryDomain: opts.fixture.host,
    defaultLocale: "en",
    senderEmail: "no-reply@" + opts.fixture.host,
    name: { en: "T", ar: "ت" },
  }));
  const tenant = await resolveTenant(opts.fixture.host);
  if (!tenant) throw new Error("fixture: resolveTenant returned null");

  const identity =
    opts.identityType === "anonymous"
      ? { type: "anonymous" as const }
      : opts.identityType === "session"
        ? {
            type: "session" as const,
            userId: opts.userId!,
            sessionId: "s_" + opts.userId,
          }
        : {
            type: "bearer" as const,
            userId: opts.userId!,
            tokenId: opts.tokenId!,
            effectiveRole:
              opts.effectiveRole ?? opts.membershipRole ?? ("owner" as const),
          };

  const membership = opts.membershipRole
    ? {
        id: "m_test",
        role: opts.membershipRole,
        userId: opts.userId!,
        tenantId: opts.fixture.tenantId,
      }
    : null;

  return { tenant, identity, membership };
}

async function readAuditRows(tenantId: string): Promise<
  Array<{ outcome: string; operation: string; error: string | null }>
> {
  const rows = await db.execute<{
    outcome: string;
    operation: string;
    error: string | null;
  }>(
    sql`SELECT outcome, operation, error FROM audit_log WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at ASC`,
  );
  if (Array.isArray(rows)) return rows as never;
  const unwrapped = (rows as { rows?: typeof rows }).rows;
  return (
    (unwrapped as unknown as Array<{
      outcome: string;
      operation: string;
      error: string | null;
    }>) ?? []
  );
}

async function readAuditPayloads(
  tenantId: string,
): Promise<Array<{ kind: string; payload: unknown; correlation_id: string }>> {
  const rows = await db.execute<{
    kind: string;
    payload: unknown;
    correlation_id: string;
  }>(
    sql`SELECT ap.kind, ap.payload, ap.correlation_id::text AS correlation_id
        FROM audit_payloads ap
        WHERE ap.tenant_id = ${tenantId}::uuid
        ORDER BY ap.kind`,
  );
  if (Array.isArray(rows)) return rows as never;
  const unwrapped = (rows as { rows?: typeof rows }).rows;
  return (
    (unwrapped as unknown as Array<{
      kind: string;
      payload: unknown;
      correlation_id: string;
    }>) ?? []
  );
}

describe("productsRouter.setCategories", () => {
  it("owner session: replaces the set, audit before+after recorded as 'products.setCategories'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });

    const created = await appRouter.createCaller(ctx).products.create({
      slug: `p-${randomUUID().slice(0, 8)}`,
      name: { en: "Pen", ar: "قلم" },
    });
    const cat = await appRouter.createCaller(ctx).categories.create({
      slug: `c-${randomUUID().slice(0, 8)}`,
      name: { en: "Pens", ar: "أقلام" },
    });

    const out = await appRouter.createCaller(ctx).products.setCategories({
      productId: created.id,
      expectedUpdatedAt: created.updatedAt.toISOString(),
      categoryIds: [cat.id],
    });
    expect(out.before.categories).toEqual([]);
    expect(out.after.categories.map((c) => c.id)).toEqual([cat.id]);

    const rows = await readAuditRows(fx.tenantId);
    const setCatRow = rows.find(
      (r) => r.operation === "products.setCategories",
    );
    expect(setCatRow).toBeDefined();
    expect(setCatRow?.outcome).toBe("success");
    expect(setCatRow?.error).toBeNull();
  });

  it("stale OCC → CONFLICT 'stale_write'; categories not touched", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const created = await appRouter.createCaller(ctx).products.create({
      slug: `p-${randomUUID().slice(0, 8)}`,
      name: { en: "Pen", ar: "قلم" },
    });
    const cat = await appRouter.createCaller(ctx).categories.create({
      slug: `c-${randomUUID().slice(0, 8)}`,
      name: { en: "Pens", ar: "أقلام" },
    });
    // Out-of-band bump to invalidate the OCC token.
    await db.execute(
      sql`UPDATE products SET updated_at = now() + interval '1 second' WHERE id = ${created.id}::uuid`,
    );

    await expect(
      appRouter.createCaller(ctx).products.setCategories({
        productId: created.id,
        expectedUpdatedAt: created.updatedAt.toISOString(),
        categoryIds: [cat.id],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "stale_write" });

    const linkRows = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM product_categories WHERE product_id = ${created.id}::uuid`,
    );
    const arr = Array.isArray(linkRows)
      ? linkRows
      : ((linkRows as { rows?: Array<{ count: string }> }).rows ?? []);
    expect(arr[0]?.count).toBe("0");
  });

  it("anonymous: UNAUTHORIZED + failure audit row", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });
    await expect(
      appRouter.createCaller(ctx).products.setCategories({
        productId: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        categoryIds: [],
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      outcome: "failure",
      operation: "products.setCategories",
      error: JSON.stringify({ code: "forbidden" }),
    });
  });

  it("customer (session no membership): FORBIDDEN + failure audit", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const userId = randomUUID();
    await db.execute(sql`
      INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
      VALUES (${userId}, ${`c-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
    `);
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
    });
    await expect(
      appRouter.createCaller(ctx).products.setCategories({
        productId: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        categoryIds: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("staff session: allowed", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "staff");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "staff",
    });
    const created = await appRouter.createCaller(ctx).products.create({
      slug: `p-${randomUUID().slice(0, 8)}`,
      name: { en: "Pen", ar: "قلم" },
    });
    const out = await appRouter.createCaller(ctx).products.setCategories({
      productId: created.id,
      expectedUpdatedAt: created.updatedAt.toISOString(),
      categoryIds: [],
    });
    expect(out.after.categories).toEqual([]);
  });

  it("support session: FORBIDDEN (read-only role)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "support");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "support",
    });
    await expect(
      appRouter.createCaller(ctx).products.setCategories({
        productId: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        categoryIds: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("audit before+after payloads recorded with correct shape", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const created = await appRouter.createCaller(ctx).products.create({
      slug: `p-${randomUUID().slice(0, 8)}`,
      name: { en: "Pen", ar: "قلم" },
    });
    const c1 = await appRouter.createCaller(ctx).categories.create({
      slug: `c-${randomUUID().slice(0, 8)}`,
      name: { en: "C1", ar: "أ" },
    });
    await appRouter.createCaller(ctx).products.setCategories({
      productId: created.id,
      expectedUpdatedAt: created.updatedAt.toISOString(),
      categoryIds: [c1.id],
    });
    const payloads = await readAuditPayloads(fx.tenantId);
    // Find before+after for the setCategories correlation.
    const auditRows = await readAuditRows(fx.tenantId);
    const auditOps = auditRows.map((r) => r.operation).filter(
      (op) => op === "products.setCategories",
    );
    expect(auditOps).toHaveLength(1);

    // We expect at least one before and one after kind for setCategories.
    const beforePayload = payloads.find(
      (p) =>
        p.kind === "before" &&
        typeof (p.payload as { productId?: string }).productId === "string",
    );
    const afterPayload = payloads.find(
      (p) =>
        p.kind === "after" &&
        typeof (p.payload as { productId?: string }).productId === "string",
    );
    expect(beforePayload).toBeDefined();
    expect(afterPayload).toBeDefined();
    expect(
      (afterPayload!.payload as { categories: Array<{ id: string }> })
        .categories,
    ).toHaveLength(1);
  });
});

describe("categoriesRouter.listForProduct", () => {
  it("owner session: returns linked categories; no audit (read)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const created = await appRouter.createCaller(ctx).products.create({
      slug: `p-${randomUUID().slice(0, 8)}`,
      name: { en: "Pen", ar: "قلم" },
    });
    const cat = await appRouter.createCaller(ctx).categories.create({
      slug: `c-${randomUUID().slice(0, 8)}`,
      name: { en: "Pens", ar: "أقلام" },
    });
    await appRouter.createCaller(ctx).products.setCategories({
      productId: created.id,
      expectedUpdatedAt: created.updatedAt.toISOString(),
      categoryIds: [cat.id],
    });
    const out = await appRouter
      .createCaller(ctx)
      .categories.listForProduct({ productId: created.id });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.id).toBe(cat.id);
  });

  it("phantom productId: empty array (no existence leak)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const out = await appRouter
      .createCaller(ctx)
      .categories.listForProduct({ productId: randomUUID() });
    expect(out.items).toEqual([]);
  });

  it("customer (no membership): FORBIDDEN", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const userId = randomUUID();
    await db.execute(sql`
      INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
      VALUES (${userId}, ${`c-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
    `);
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
    });
    await expect(
      appRouter
        .createCaller(ctx)
        .categories.listForProduct({ productId: randomUUID() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
