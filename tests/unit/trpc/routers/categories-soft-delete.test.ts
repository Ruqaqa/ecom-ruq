/**
 * Chunk 1a.4.3 — tRPC router-level coverage for the three new
 * categories mutations:
 *   - categories.delete            (owner+staff, cascade soft-delete,
 *                                    OCC translation, confirm-required)
 *   - categories.restore           (owner+staff, single-row restore,
 *                                    parent_still_removed,
 *                                    RestoreWindowExpiredError →
 *                                    BAD_REQUEST `restore_expired`)
 *   - categories.hardDeleteExpired (owner-only sweeper)
 *
 * Real DB round-trip via `withTenant`. We assert role gates, audit
 * outcome rows, and the closed-set error mappings — not the service
 * internals (the service tests cover those).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { categories } from "@/server/db/schema/catalog";

beforeAll(() => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");
});

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const client = postgres(DATABASE_URL, { max: 4 });
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
  const slug = `e2e-csd-${id.slice(0, 8)}`;
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

async function seedLiveCategory(
  tenantId: string,
  opts: { parentId?: string | null } = {},
): Promise<{ id: string; slug: string; updatedAt: Date }> {
  const id = randomUUID();
  const slug = `e2e-c-${id.slice(0, 8)}`;
  const parentId = opts.parentId ?? null;
  await db.execute(sql`
    INSERT INTO categories (id, tenant_id, slug, name, parent_id)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "C", ar: "ت" })}'::jsonb`)},
      ${parentId})
  `);
  const rows = await db
    .select({ updatedAt: categories.updatedAt })
    .from(categories)
    .where(eq(categories.id, id))
    .limit(1);
  return { id, slug, updatedAt: rows[0]!.updatedAt };
}

async function softDelete(
  tenantId: string,
  id: string,
  daysAgo = 1,
): Promise<void> {
  await db.execute(
    sql`UPDATE categories SET deleted_at = now() - (${daysAgo}::int || ' days')::interval
        WHERE id = ${id} AND tenant_id = ${tenantId}`,
  );
}

async function softDeleteExpired(
  tenantId: string,
  id: string,
): Promise<void> {
  await softDelete(tenantId, id, 31);
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

interface AuditRow {
  outcome: string;
  operation: string;
  error: string | null;
  [k: string]: unknown;
}

async function readAuditRows(tenantId: string): Promise<AuditRow[]> {
  const rows = await db.execute<AuditRow>(
    sql`SELECT outcome, operation, error
        FROM audit_log WHERE tenant_id = ${tenantId}::uuid
        ORDER BY created_at ASC`,
  );
  if (Array.isArray(rows)) return rows as never;
  const unwrapped = (rows as { rows?: AuditRow[] }).rows;
  return unwrapped ?? [];
}

describe("categoriesRouter.delete", () => {
  it("owner success: row removed; success audit row", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const seeded = await seedLiveCategory(fx.tenantId);

    const out = await appRouter.createCaller(ctx).categories.delete({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      confirm: true,
    });
    expect(out.id).toBe(seeded.id);
    expect(out.deletedAt).toBeInstanceOf(Date);

    const rows = await readAuditRows(fx.tenantId);
    expect(
      rows.some(
        (r) =>
          r.operation === "categories.delete" && r.outcome === "success",
      ),
    ).toBe(true);
  });

  it("staff success", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "staff");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "staff",
    });
    const seeded = await seedLiveCategory(fx.tenantId);
    const out = await appRouter.createCaller(ctx).categories.delete({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      confirm: true,
    });
    expect(out.id).toBe(seeded.id);
  });

  it("anonymous: UNAUTHORIZED + failure audit 'forbidden'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });
    const seeded = await seedLiveCategory(fx.tenantId);
    await expect(
      appRouter.createCaller(ctx).categories.delete({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const rows = await readAuditRows(fx.tenantId);
    expect(
      rows.some(
        (r) =>
          r.operation === "categories.delete" &&
          r.outcome === "failure" &&
          r.error === JSON.stringify({ code: "forbidden" }),
      ),
    ).toBe(true);
  });

  it("customer (session no membership): FORBIDDEN", async () => {
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
    const seeded = await seedLiveCategory(fx.tenantId);
    await expect(
      appRouter.createCaller(ctx).categories.delete({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("missing confirm: validation_failed audit row", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const seeded = await seedLiveCategory(fx.tenantId);
    await expect(
      appRouter.createCaller(ctx).categories.delete({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
      } as never),
    ).rejects.toThrow();
    const rows = await readAuditRows(fx.tenantId);
    expect(
      rows.some(
        (r) =>
          r.operation === "categories.delete" &&
          r.error === JSON.stringify({ code: "validation_failed" }),
      ),
    ).toBe(true);
  });

  it("stale OCC: CONFLICT 'stale_write' + failure audit row", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const seeded = await seedLiveCategory(fx.tenantId);
    // Bump updated_at via a real edit to make the cached token stale.
    await appRouter.createCaller(ctx).categories.update({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      position: 7,
    });
    await expect(
      appRouter.createCaller(ctx).categories.delete({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "stale_write" });
    const rows = await readAuditRows(fx.tenantId);
    expect(
      rows.some(
        (r) =>
          r.operation === "categories.delete" &&
          r.error === JSON.stringify({ code: "stale_write" }),
      ),
    ).toBe(true);
  });
});

describe("categoriesRouter.restore", () => {
  it("owner success: row restored; success audit row", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const seeded = await seedLiveCategory(fx.tenantId);
    await softDelete(fx.tenantId, seeded.id);

    const out = await appRouter
      .createCaller(ctx)
      .categories.restore({ id: seeded.id, confirm: true });
    expect(out.id).toBe(seeded.id);
    expect(out.deletedAt).toBeNull();
  });

  it("expired window: BAD_REQUEST 'restore_expired' + failure audit row", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const seeded = await seedLiveCategory(fx.tenantId);
    await softDeleteExpired(fx.tenantId, seeded.id);

    await expect(
      appRouter
        .createCaller(ctx)
        .categories.restore({ id: seeded.id, confirm: true }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "restore_expired",
    });
    const rows = await readAuditRows(fx.tenantId);
    expect(
      rows.some(
        (r) =>
          r.operation === "categories.restore" &&
          r.outcome === "failure" &&
          r.error === JSON.stringify({ code: "restore_expired" }),
      ),
    ).toBe(true);
  });

  it("parent still removed: BAD_REQUEST 'parent_still_removed'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const parent = await seedLiveCategory(fx.tenantId);
    const child = await seedLiveCategory(fx.tenantId, { parentId: parent.id });
    await softDelete(fx.tenantId, parent.id);
    await softDelete(fx.tenantId, child.id);

    await expect(
      appRouter
        .createCaller(ctx)
        .categories.restore({ id: child.id, confirm: true }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "parent_still_removed",
    });
  });

  it("customer: FORBIDDEN", async () => {
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
        .categories.restore({ id: randomUUID(), confirm: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("missing confirm: validation_failed audit row", async () => {
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
      appRouter
        .createCaller(ctx)
        .categories.restore({ id: randomUUID() } as never),
    ).rejects.toThrow();
    const rows = await readAuditRows(fx.tenantId);
    expect(
      rows.some(
        (r) =>
          r.operation === "categories.restore" &&
          r.error === JSON.stringify({ code: "validation_failed" }),
      ),
    ).toBe(true);
  });
});

describe("categoriesRouter.hardDeleteExpired", () => {
  it("owner success: returns {count, ids, dryRun:false}", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const a = await seedLiveCategory(fx.tenantId);
    await softDeleteExpired(fx.tenantId, a.id);

    const out = await appRouter
      .createCaller(ctx)
      .categories.hardDeleteExpired({ confirm: true, dryRun: false });
    expect(out.count).toBeGreaterThanOrEqual(1);
    expect(out.ids).toContain(a.id);
    expect(out.dryRun).toBe(false);

    const rows = await readAuditRows(fx.tenantId);
    expect(
      rows.some(
        (r) =>
          r.operation === "categories.hardDeleteExpired" &&
          r.outcome === "success",
      ),
    ).toBe(true);
  });

  it("dryRun:true returns ids without deleting", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const a = await seedLiveCategory(fx.tenantId);
    await softDeleteExpired(fx.tenantId, a.id);

    const out = await appRouter
      .createCaller(ctx)
      .categories.hardDeleteExpired({ confirm: true, dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.ids).toContain(a.id);

    // Row still present.
    const stillThere = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, a.id));
    expect(stillThere.length).toBe(1);
  });

  it("staff: FORBIDDEN (owner-only gate, NOT isWriteRole)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "staff");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "staff",
    });
    await expect(
      appRouter
        .createCaller(ctx)
        .categories.hardDeleteExpired({ confirm: true, dryRun: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("missing confirm: rejected even with dryRun:true", async () => {
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
      appRouter
        .createCaller(ctx)
        .categories.hardDeleteExpired({ dryRun: true } as never),
    ).rejects.toThrow();
  });
});
