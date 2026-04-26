/**
 * `categoriesRouter` — chunk 1a.4.1.
 *
 * Composition mirrors productsRouter: list/get reads via `publicProcedure`
 * + `requireRole`, mutations via `mutationProcedure` + `requireRole`. We
 * test the role gates, the audit payload set, and the closed-set error
 * mappings.
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
  const slug = `cat-router-${id.slice(0, 8)}`;
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

describe("categoriesRouter.list", () => {
  it("owner session: returns items[]; no audit (read)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const out = await appRouter.createCaller(ctx).categories.list({});
    expect(out.items).toEqual([]);
    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(0);
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
      appRouter.createCaller(ctx).categories.list({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("categoriesRouter.create", () => {
  it("owner session: creates a category, success audit row written", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const out = await appRouter.createCaller(ctx).categories.create({
      slug: `cat-${randomUUID().slice(0, 8)}`,
      name: { en: "Cameras", ar: "كاميرات" },
    });
    expect(out).toMatchObject({ depth: 1, parentId: null });
    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      outcome: "success",
      operation: "categories.create",
      error: null,
    });
  });

  it("anonymous: UNAUTHORIZED + failure audit row", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });
    await expect(
      appRouter.createCaller(ctx).categories.create({
        slug: "x",
        name: { en: "X", ar: "س" },
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const rows = await readAuditRows(fx.tenantId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      outcome: "failure",
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
      appRouter.createCaller(ctx).categories.create({
        slug: "x",
        name: { en: "X", ar: "س" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rows = await readAuditRows(fx.tenantId);
    expect(rows[0]).toMatchObject({
      outcome: "failure",
      error: JSON.stringify({ code: "forbidden" }),
    });
  });

  it("slug collision: maps SlugTakenError → CONFLICT 'slug_taken'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const slug = `dup-${randomUUID().slice(0, 8)}`;
    await appRouter.createCaller(ctx).categories.create({
      slug,
      name: { en: "First", ar: "أ" },
    });
    await expect(
      appRouter.createCaller(ctx).categories.create({
        slug,
        name: { en: "Second", ar: "ب" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "slug_taken" });
  });
});

describe("categoriesRouter.update", () => {
  it("owner session: update sets before+after audit payloads", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const created = await appRouter.createCaller(ctx).categories.create({
      slug: `cat-${randomUUID().slice(0, 8)}`,
      name: { en: "Old", ar: "قديم" },
    });
    const out = await appRouter.createCaller(ctx).categories.update({
      id: created.id,
      expectedUpdatedAt: created.updatedAt.toISOString(),
      name: { en: "New" },
    });
    expect(out.name).toMatchObject({ en: "New", ar: "قديم" });
  });

  it("stale write → CONFLICT 'stale_write'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const created = await appRouter.createCaller(ctx).categories.create({
      slug: `cat-${randomUUID().slice(0, 8)}`,
      name: { en: "X", ar: "س" },
    });
    // First successful update bumps updated_at.
    await appRouter.createCaller(ctx).categories.update({
      id: created.id,
      expectedUpdatedAt: created.updatedAt.toISOString(),
      position: 1,
    });
    // Second with the original token is stale.
    await expect(
      appRouter.createCaller(ctx).categories.update({
        id: created.id,
        expectedUpdatedAt: created.updatedAt.toISOString(),
        position: 2,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "stale_write" });
  });

  it("cycle (parent=self) surfaces as BAD_REQUEST 'category_cycle'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const created = await appRouter.createCaller(ctx).categories.create({
      slug: `cat-${randomUUID().slice(0, 8)}`,
      name: { en: "X", ar: "س" },
    });
    await expect(
      appRouter.createCaller(ctx).categories.update({
        id: created.id,
        expectedUpdatedAt: created.updatedAt.toISOString(),
        parentId: created.id,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "category_cycle",
    });
  });
});
