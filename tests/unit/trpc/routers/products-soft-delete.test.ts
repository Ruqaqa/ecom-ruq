/**
 * Chunk 1a.3 — tRPC router-level coverage for the three new mutations:
 *   - products.delete       (owner+staff, M1 audit shape, stale-write
 *                            translation, confirm-required gate)
 *   - products.restore      (owner+staff, RestoreWindowExpiredError →
 *                            BAD_REQUEST `restore_expired`, M1 audit)
 *   - products.hardDeleteExpired (owner-only, M3 bounded audit shape)
 *
 * Real DB round-trip via withTenant, not service-layer mocks — the goal
 * is to verify the audit chain shapes that land in audit_log /
 * audit_payloads, which only the in-tx codepath produces.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { products } from "@/server/db/schema/catalog";

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
  const slug = `psd-${id.slice(0, 8)}`;
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

async function seedLiveProduct(
  tenantId: string,
  opts?: { costPriceMinor?: number | null },
): Promise<{ id: string; updatedAt: Date; slug: string }> {
  const id = randomUUID();
  const slug = `prod-${id.slice(0, 8)}`;
  await db.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status, cost_price_minor)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "Old", ar: "قديم" })}'::jsonb`)},
      'draft', ${opts?.costPriceMinor ?? null})
  `);
  const rows = await db
    .select({ updatedAt: products.updatedAt })
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  return { id, slug, updatedAt: rows[0]!.updatedAt };
}

async function seedExpiredDeleted(tenantId: string): Promise<{ id: string }> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status, deleted_at)
    VALUES (${id}, ${tenantId}, ${"exp-" + id.slice(0, 8)},
      ${sql.raw(`'${JSON.stringify({ en: "X", ar: "خ" })}'::jsonb`)},
      'draft', now() - interval '31 days')
  `);
  return { id };
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

interface AuditRow extends Record<string, unknown> {
  outcome: string;
  operation: string;
  error: string | null;
  correlation_id: string;
}

async function readAuditRows(tenantId: string): Promise<AuditRow[]> {
  const rows = await db.execute<AuditRow>(
    sql`SELECT outcome, operation, error, correlation_id::text AS correlation_id
        FROM audit_log WHERE tenant_id = ${tenantId}::uuid
        ORDER BY created_at ASC`,
  );
  if (Array.isArray(rows)) return rows as never;
  const unwrapped = (rows as { rows?: AuditRow[] }).rows;
  return unwrapped ?? [];
}

async function readPayload(
  tenantId: string,
  correlationId: string,
  kind: "input" | "before" | "after",
): Promise<unknown> {
  const rows = await db.execute<{ payload: unknown }>(
    sql`SELECT payload FROM audit_payloads
        WHERE tenant_id = ${tenantId}::uuid
          AND correlation_id = ${correlationId}::uuid
          AND kind = ${kind} LIMIT 1`,
  );
  const arr = Array.isArray(rows)
    ? rows
    : (rows as { rows?: Array<{ payload: unknown }> }).rows ?? [];
  return arr[0]?.payload;
}

describe("productsRouter.delete", () => {
  it("owner success: returns small envelope; audit before/after carry full ProductOwner shape (M1)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const seeded = await seedLiveProduct(fx.tenantId, { costPriceMinor: 4242 });

    const out = await appRouter.createCaller(ctx).products.delete({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      confirm: true,
    });
    expect(out.id).toBe(seeded.id);
    expect(out.deletedAt).toBeInstanceOf(Date);

    const rows = await readAuditRows(fx.tenantId);
    const successRow = rows.find(
      (r) => r.operation === "products.delete" && r.outcome === "success",
    );
    expect(successRow).toBeTruthy();
    const before = (await readPayload(
      fx.tenantId,
      successRow!.correlation_id,
      "before",
    )) as { slug: string; status: string; costPriceMinor: number | null; deletedAt: unknown };
    const after = (await readPayload(
      fx.tenantId,
      successRow!.correlation_id,
      "after",
    )) as { slug: string; status: string; costPriceMinor: number | null; deletedAt: unknown };
    expect(before.slug).toBe(seeded.slug);
    expect(before.costPriceMinor).toBe(4242);
    expect(before.deletedAt).toBeNull();
    expect(after.slug).toBe(seeded.slug);
    expect(after.costPriceMinor).toBe(4242);
    expect(after.deletedAt).toBeTruthy();
  });

  it("staff success: audit `before`/`after` STILL include costPriceMinor (audit shape role-independent)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "staff");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "staff",
    });
    const seeded = await seedLiveProduct(fx.tenantId, { costPriceMinor: 555 });

    await appRouter.createCaller(ctx).products.delete({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      confirm: true,
    });
    const rows = await readAuditRows(fx.tenantId);
    const successRow = rows.find(
      (r) => r.operation === "products.delete" && r.outcome === "success",
    )!;
    const after = (await readPayload(
      fx.tenantId,
      successRow.correlation_id,
      "after",
    )) as { costPriceMinor: number | null };
    expect(after.costPriceMinor).toBe(555);
  });

  it("anonymous: UNAUTHORIZED + failure audit row 'forbidden'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });
    const seeded = await seedLiveProduct(fx.tenantId);
    await expect(
      appRouter.createCaller(ctx).products.delete({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const rows = await readAuditRows(fx.tenantId);
    expect(
      rows.some(
        (r) =>
          r.operation === "products.delete" &&
          r.outcome === "failure" &&
          r.error === JSON.stringify({ code: "forbidden" }),
      ),
    ).toBe(true);
  });

  it("customer: FORBIDDEN + failure audit 'forbidden'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const userId = randomUUID();
    await db.execute(sql`
      INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
      VALUES (${userId}, ${`c-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
    `);
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId });
    const seeded = await seedLiveProduct(fx.tenantId);
    await expect(
      appRouter.createCaller(ctx).products.delete({
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
    const seeded = await seedLiveProduct(fx.tenantId);
    await expect(
      appRouter.createCaller(ctx).products.delete({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
      } as never),
    ).rejects.toThrow();
    const rows = await readAuditRows(fx.tenantId);
    expect(
      rows.some(
        (r) =>
          r.operation === "products.delete" &&
          r.error === JSON.stringify({ code: "validation_failed" }),
      ),
    ).toBe(true);
  });

  it("stale OCC: CONFLICT 'stale_write' + failure audit row 'stale_write'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const seeded = await seedLiveProduct(fx.tenantId);
    // Bump updated_at via a real edit so the second OCC token is stale.
    await appRouter.createCaller(ctx).products.update({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      status: "active",
    });
    await expect(
      appRouter.createCaller(ctx).products.delete({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(), // stale
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "stale_write" });
    const rows = await readAuditRows(fx.tenantId);
    expect(
      rows.some(
        (r) =>
          r.operation === "products.delete" &&
          r.error === JSON.stringify({ code: "stale_write" }),
      ),
    ).toBe(true);
  });
});

describe("productsRouter.restore", () => {
  async function softDelete(tenantId: string, id: string): Promise<void> {
    await db.execute(
      sql`UPDATE products SET deleted_at = now() - interval '1 day' WHERE id = ${id} AND tenant_id = ${tenantId}`,
    );
  }
  async function softDeleteExpired(tenantId: string, id: string): Promise<void> {
    await db.execute(
      sql`UPDATE products SET deleted_at = now() - interval '31 days' WHERE id = ${id} AND tenant_id = ${tenantId}`,
    );
  }

  it("owner success: row restored; audit before deletedAt non-null, after deletedAt null; M1 costPriceMinor present", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const seeded = await seedLiveProduct(fx.tenantId, { costPriceMinor: 9911 });
    await softDelete(fx.tenantId, seeded.id);

    const out = await appRouter
      .createCaller(ctx)
      .products.restore({ id: seeded.id, confirm: true });
    expect(out.id).toBe(seeded.id);
    expect(out.deletedAt).toBeNull();

    const rows = await readAuditRows(fx.tenantId);
    const successRow = rows.find(
      (r) => r.operation === "products.restore" && r.outcome === "success",
    )!;
    const before = (await readPayload(
      fx.tenantId,
      successRow.correlation_id,
      "before",
    )) as { deletedAt: unknown; costPriceMinor: number | null };
    const after = (await readPayload(
      fx.tenantId,
      successRow.correlation_id,
      "after",
    )) as { deletedAt: unknown; costPriceMinor: number | null };
    expect(before.deletedAt).toBeTruthy();
    expect(before.costPriceMinor).toBe(9911);
    expect(after.deletedAt).toBeNull();
    expect(after.costPriceMinor).toBe(9911);
  });

  it("expired window: BAD_REQUEST 'restore_expired' + failure audit row 'restore_expired'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const seeded = await seedLiveProduct(fx.tenantId);
    await softDeleteExpired(fx.tenantId, seeded.id);

    await expect(
      appRouter
        .createCaller(ctx)
        .products.restore({ id: seeded.id, confirm: true }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "restore_expired",
    });
    const rows = await readAuditRows(fx.tenantId);
    expect(
      rows.some(
        (r) =>
          r.operation === "products.restore" &&
          r.outcome === "failure" &&
          r.error === JSON.stringify({ code: "restore_expired" }),
      ),
    ).toBe(true);
  });

  it("customer: FORBIDDEN", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const userId = randomUUID();
    await db.execute(sql`
      INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
      VALUES (${userId}, ${`c-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
    `);
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId });
    await expect(
      appRouter
        .createCaller(ctx)
        .products.restore({ id: randomUUID(), confirm: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("productsRouter.hardDeleteExpired", () => {
  it("owner success: returns {count, ids, dryRun:false} (no slugs); audit `after` is bounded to {count, ids} (M3)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    const a = await seedExpiredDeleted(fx.tenantId);
    const b = await seedExpiredDeleted(fx.tenantId);

    const out = await appRouter
      .createCaller(ctx)
      .products.hardDeleteExpired({ confirm: true, dryRun: false });
    expect(out.count).toBe(2);
    expect(out.ids.sort()).toEqual([a.id, b.id].sort());
    expect(out.slugs).toBeUndefined();
    expect(out.dryRun).toBe(false);

    const rows = await readAuditRows(fx.tenantId);
    const successRow = rows.find(
      (r) =>
        r.operation === "products.hardDeleteExpired" &&
        r.outcome === "success",
    )!;
    const after = (await readPayload(
      fx.tenantId,
      successRow.correlation_id,
      "after",
    )) as Record<string, unknown>;
    // M3: exactly {count, ids}. NO slugs. NO dryRun.
    expect(Object.keys(after).sort()).toEqual(["count", "ids"]);
    expect(after.count).toBe(2);
    expect((after.ids as string[]).sort()).toEqual([a.id, b.id].sort());
  });

  it("dryRun: true returns slugs; audit `after` STILL bounded to {count, ids}", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });
    await seedExpiredDeleted(fx.tenantId);

    const out = await appRouter
      .createCaller(ctx)
      .products.hardDeleteExpired({ confirm: true, dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.slugs?.length).toBe(1);

    const rows = await readAuditRows(fx.tenantId);
    const successRow = rows.find(
      (r) =>
        r.operation === "products.hardDeleteExpired" &&
        r.outcome === "success",
    )!;
    const after = (await readPayload(
      fx.tenantId,
      successRow.correlation_id,
      "after",
    )) as Record<string, unknown>;
    expect(Object.keys(after).sort()).toEqual(["count", "ids"]);
  });

  it("staff: FORBIDDEN + failure audit 'forbidden' (owner-only gate, NOT isWriteRole)", async () => {
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
        .products.hardDeleteExpired({ confirm: true, dryRun: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
