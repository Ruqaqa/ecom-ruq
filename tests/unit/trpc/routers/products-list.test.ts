/**
 * `productsRouter.list` tRPC procedure — read path (chunk 1a.1).
 *
 * Contract:
 *   - query, not mutation. NO audit row on success (reads bypass audit-wrap per prd §3.7).
 *   - requireRole({ roles: ['owner','staff'], identity: 'any' }) — bearer PATs allowed.
 *   - anonymous → UNAUTHORIZED.
 *   - customer/support → FORBIDDEN.
 *   - bearer owner → success.
 *   - Zod input validation for limit bounds.
 *   - Tenant isolation: wire carries ctx.tenant.id via withTenant.
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
  const slug = `list-router-${id.slice(0, 8)}`;
  const host = `${slug}.local`;
  await db.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${host}, 'en', ${"no-reply@" + host},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
  return { tenantId: id, host };
}

async function seedProducts(tenantId: string, n: number, tag = "P"): Promise<void> {
  const base = Date.now();
  for (let i = 0; i < n; i++) {
    const slug = `sp-${randomUUID().slice(0, 8)}`;
    const ts = new Date(base - i * 1000).toISOString();
    await db.execute(sql`
      INSERT INTO products (tenant_id, slug, name, status, created_at, updated_at)
      VALUES (${tenantId}::uuid, ${slug},
        ${sql.raw(`'${JSON.stringify({ en: `${tag} ${i}`, ar: `م ${i}` }).replace(/'/g, "''")}'::jsonb`)},
        'draft', ${ts}::timestamptz, ${ts}::timestamptz)
    `);
  }
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

async function readAuditRowCount(tenantId: string): Promise<number> {
  const rows = await db.execute<{ c: string }>(
    sql`SELECT count(*)::text AS c FROM audit_log WHERE tenant_id = ${tenantId}::uuid`,
  );
  const arr = Array.isArray(rows)
    ? rows
    : (rows as { rows?: Array<{ c: string }> }).rows ?? [];
  return Number(arr[0]?.c ?? 0);
}

describe("productsRouter.list", () => {
  it("owner session: returns items and writes NO audit row (read path)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    await seedProducts(fx.tenantId, 3, "O");
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });

    const out = await appRouter.createCaller(ctx).products.list({});
    expect(out.items.length).toBe(3);
    expect(out.hasMore).toBe(false);
    expect(out.nextCursor).toBeNull();

    const n = await readAuditRowCount(fx.tenantId);
    expect(n).toBe(0);
  });

  it("staff session: returns items (same role allowlist as owner)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    await seedProducts(fx.tenantId, 2, "S");
    const { userId } = await makeUserAndMembership(fx.tenantId, "staff");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "staff",
    });

    const out = await appRouter.createCaller(ctx).products.list({});
    expect(out.items.length).toBe(2);
  });

  it("anonymous caller: UNAUTHORIZED", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });
    await expect(
      appRouter.createCaller(ctx).products.list({}),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("customer (session + no membership): FORBIDDEN", async () => {
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
      appRouter.createCaller(ctx).products.list({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("support session: FORBIDDEN (only owner/staff allowed for admin list)", async () => {
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
      appRouter.createCaller(ctx).products.list({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("bearer owner: SUCCESS (identity:'any' preserves bearer access)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    await seedProducts(fx.tenantId, 1, "B");
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "bearer",
      userId,
      tokenId: "t_" + userId,
      membershipRole: "owner",
      effectiveRole: "owner",
    });

    const out = await appRouter.createCaller(ctx).products.list({});
    expect(out.items.length).toBe(1);
  });

  it("invalid input (limit=0): Zod BAD_REQUEST", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    await expect(
      appRouter.createCaller(ctx).products.list({ limit: 0 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("tenant isolation: tenant-A owner does not see tenant-B rows", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fxA = await makeTenant();
    const fxB = await makeTenant();
    await seedProducts(fxA.tenantId, 2, "A");
    await seedProducts(fxB.tenantId, 3, "B");
    const { userId } = await makeUserAndMembership(fxA.tenantId, "owner");
    const ctxA = await buildCtx({
      fixture: fxA,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const out = await appRouter.createCaller(ctxA).products.list({});
    expect(out.items.length).toBe(2);
    const dump = JSON.stringify(out);
    expect(dump).not.toContain('"B 0"');
    expect(dump).not.toContain('"B 1"');
    expect(dump).not.toContain('"B 2"');
  });
});
