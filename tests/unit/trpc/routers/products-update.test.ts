/**
 * `productsRouter.update` + `productsRouter.get` tRPC integration tests.
 *
 * Composition under test:
 *   get:    publicProcedure
 *             .use(requireRole({ roles:['owner','staff'], identity:'any' }))
 *             .input({ id }).query(...)
 *   update: mutationProcedure
 *             .use(requireRole({ roles:['owner','staff'] }))    // identity:'any' default
 *             .input(UpdateProductInputSchema).mutation(...)
 *
 * Audit shape verification: success rows must carry the FULL
 * ProductOwner shape (incl. costPriceMinor) in BOTH `before` and
 * `after` payloads — even when the caller is staff. Failure rows
 * carry only field-path forensic signal in `input`.
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
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
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
  const slug = `pu-router-${id.slice(0, 8)}`;
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

async function seedProductRow(
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

interface BuildCtxOpts {
  fixture: TenantFixture;
  identityType: "anonymous" | "session" | "bearer";
  userId?: string;
  tokenId?: string;
  membershipRole?: "owner" | "staff" | "support";
  effectiveRole?: "owner" | "staff" | "support";
}

async function buildCtx(opts: BuildCtxOpts) {
  const { resolveTenant, __setTenantLookupLoaderForTests, clearTenantCacheForTests } = await import(
    "@/server/tenant"
  );
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
        ? { type: "session" as const, userId: opts.userId!, sessionId: "s_" + opts.userId }
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
  Array<{ outcome: string; operation: string; error: string | null; correlation_id: string }>
> {
  const rows = await db.execute<{
    outcome: string;
    operation: string;
    error: string | null;
    correlation_id: string;
  }>(
    sql`SELECT outcome, operation, error, correlation_id::text AS correlation_id FROM audit_log WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at ASC`,
  );
  if (Array.isArray(rows)) return rows as never;
  const unwrapped = (rows as { rows?: typeof rows }).rows;
  return (unwrapped as unknown as Array<{ outcome: string; operation: string; error: string | null; correlation_id: string }>) ?? [];
}

async function readPayload(
  tenantId: string,
  correlationId: string,
  kind: "input" | "before" | "after",
): Promise<unknown> {
  const rows = await db.execute<{ payload: unknown }>(
    sql`SELECT payload FROM audit_payloads WHERE tenant_id = ${tenantId}::uuid AND correlation_id = ${correlationId}::uuid AND kind = ${kind} LIMIT 1`,
  );
  const arr = Array.isArray(rows)
    ? rows
    : (rows as { rows?: Array<{ payload: unknown }> }).rows ?? [];
  return arr[0]?.payload;
}

describe("productsRouter.update", () => {
  it("owner session: success — ProductOwner returned + audit success row", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });
    const seeded = await seedProductRow(fx.tenantId, { costPriceMinor: 10 });

    const out = await appRouter.createCaller(ctx).products.update({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      status: "active",
      costPriceMinor: 50,
    });
    expect(out).toMatchObject({ status: "active", costPriceMinor: 50 });

    const rows = await readAuditRows(fx.tenantId);
    const updateRow = rows.find((r) => r.operation === "products.update" && r.outcome === "success");
    expect(updateRow).toBeTruthy();
    expect(updateRow!.error).toBeNull();
  });

  it("owner session: audit before+after payloads carry costPriceMinor (full Tier-B shape recorded)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });
    const seeded = await seedProductRow(fx.tenantId, { costPriceMinor: 100 });

    await appRouter.createCaller(ctx).products.update({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      costPriceMinor: 200,
    });
    const rows = await readAuditRows(fx.tenantId);
    const successRow = rows.find((r) => r.operation === "products.update" && r.outcome === "success")!;
    const before = (await readPayload(fx.tenantId, successRow.correlation_id, "before")) as { costPriceMinor: number | null };
    const after = (await readPayload(fx.tenantId, successRow.correlation_id, "after")) as { costPriceMinor: number | null };
    expect(before.costPriceMinor).toBe(100);
    expect(after.costPriceMinor).toBe(200);
  });

  it("staff session: success on non-Tier-B edit; audit before+after STILL carry costPriceMinor (full audit shape regardless of caller role)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "staff");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "staff" });
    const seeded = await seedProductRow(fx.tenantId, { costPriceMinor: 4242 });

    await appRouter.createCaller(ctx).products.update({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      status: "active",
    });
    const rows = await readAuditRows(fx.tenantId);
    const successRow = rows.find((r) => r.operation === "products.update" && r.outcome === "success")!;
    const before = (await readPayload(fx.tenantId, successRow.correlation_id, "before")) as { costPriceMinor: number | null };
    const after = (await readPayload(fx.tenantId, successRow.correlation_id, "after")) as { costPriceMinor: number | null };
    expect(before.costPriceMinor).toBe(4242);
    expect(after.costPriceMinor).toBe(4242);
  });

  it("anonymous: UNAUTHORIZED + failure audit row error 'forbidden'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });
    const seeded = await seedProductRow(fx.tenantId);

    await expect(
      appRouter.createCaller(ctx).products.update({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const rows = await readAuditRows(fx.tenantId);
    expect(rows).toContainEqual(
      expect.objectContaining({
        operation: "products.update",
        outcome: "failure",
        error: JSON.stringify({ code: "forbidden" }),
      }),
    );
  });

  it("session+no-membership (customer): FORBIDDEN + failure audit row error 'forbidden'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const userId = randomUUID();
    await db.execute(sql`
      INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
      VALUES (${userId}, ${`c-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
    `);
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId });
    const seeded = await seedProductRow(fx.tenantId);

    await expect(
      appRouter.createCaller(ctx).products.update({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rows = await readAuditRows(fx.tenantId);
    expect(rows).toContainEqual(
      expect.objectContaining({
        operation: "products.update",
        outcome: "failure",
        error: JSON.stringify({ code: "forbidden" }),
      }),
    );
  });

  it("session+support: FORBIDDEN + failure audit row 'forbidden'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "support");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "support" });
    const seeded = await seedProductRow(fx.tenantId);

    await expect(
      appRouter.createCaller(ctx).products.update({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rows = await readAuditRows(fx.tenantId);
    expect(rows).toContainEqual(
      expect.objectContaining({
        operation: "products.update",
        outcome: "failure",
        error: JSON.stringify({ code: "forbidden" }),
      }),
    );
  });

  it("bearer owner caller: SUCCESS (identity:'any' default)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "bearer",
      userId,
      tokenId: "t_" + userId,
      membershipRole: "owner",
      effectiveRole: "owner",
    });
    const seeded = await seedProductRow(fx.tenantId);

    const out = await appRouter.createCaller(ctx).products.update({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      status: "active",
    });
    expect(out).toMatchObject({ status: "active" });
  });

  it("owner + invalid input (121-char slug): validation_failed; input payload is field-paths only — slug value NEVER in audit", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });
    const seeded = await seedProductRow(fx.tenantId);

    const sentinel = "secret-slug-do-not-leak-canary";
    const slug = sentinel + "-" + "a".repeat(121 - sentinel.length - 1);
    expect(slug.length).toBe(121);

    await expect(
      appRouter.createCaller(ctx).products.update({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        slug,
      }),
    ).rejects.toThrow();

    const rows = await readAuditRows(fx.tenantId);
    const failureRow = rows.find((r) => r.operation === "products.update" && r.outcome === "failure")!;
    expect(failureRow.error).toBe(JSON.stringify({ code: "validation_failed" }));
    const inputPayload = (await readPayload(
      fx.tenantId,
      failureRow.correlation_id,
      "input",
    )) as { kind: string; failedPaths: string[] };
    expect(inputPayload.kind).toBe("validation");
    expect(JSON.stringify(inputPayload.failedPaths)).toMatch(/slug/);
    expect(JSON.stringify(inputPayload)).not.toContain(sentinel);
  });

  it("owner + missing expectedUpdatedAt: validation_failed audit row", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });
    const seeded = await seedProductRow(fx.tenantId);

    await expect(
      appRouter.createCaller(ctx).products.update({
        id: seeded.id,
        status: "active",
      } as never),
    ).rejects.toThrow();
    const rows = await readAuditRows(fx.tenantId);
    expect(rows.some((r) => r.error === JSON.stringify({ code: "validation_failed" }))).toBe(true);
  });

  it("owner + tenantId in input: rejected by Zod; the wire row's tenant_id was never reachable", async () => {
    // The input schema has no tenantId field; tRPC's input validator
    // strips unknown keys (object()'s default) — the call passes Zod
    // but the spurious key is silently dropped, the products row's
    // tenant_id stays = ctx.tenant.id, and the post-update tenant_id
    // matches.
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });
    const seeded = await seedProductRow(fx.tenantId);

    await appRouter.createCaller(ctx).products.update({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      status: "active",
      tenantId: randomUUID(), // ignored by Zod object() default behaviour
    } as never);
    const dbRows = await db.execute<{ tenant_id: string }>(
      sql`SELECT tenant_id::text AS tenant_id FROM products WHERE id = ${seeded.id}`,
    );
    const arr = Array.isArray(dbRows) ? dbRows : (dbRows as { rows?: Array<{ tenant_id: string }> }).rows ?? [];
    expect(arr[0]?.tenant_id).toBe(fx.tenantId);
  });

  it("owner + stale expectedUpdatedAt: typed conflict on the wire AND audit error 'stale_write'; row unchanged in DB", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });
    const seeded = await seedProductRow(fx.tenantId);

    // Bump updated_at so the second call is stale.
    await appRouter.createCaller(ctx).products.update({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      status: "active",
    });

    await expect(
      appRouter.createCaller(ctx).products.update({
        id: seeded.id,
        expectedUpdatedAt: seeded.updatedAt.toISOString(),
        name: { en: "ShouldNotApply", ar: "ج" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "stale_write" });
    const rows = await readAuditRows(fx.tenantId);
    expect(rows).toContainEqual(
      expect.objectContaining({
        operation: "products.update",
        outcome: "failure",
        error: JSON.stringify({ code: "stale_write" }),
      }),
    );
    const dbRows = await db.select().from(products).where(eq(products.id, seeded.id));
    expect((dbRows[0]?.name as { en: string }).en).not.toBe("ShouldNotApply");
  });

  it("owner + slug-collision: TRPCError CONFLICT 'slug_taken' AND audit error 'conflict'; target row unchanged", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });
    const a = await seedProductRow(fx.tenantId);
    const b = await seedProductRow(fx.tenantId);

    await expect(
      appRouter.createCaller(ctx).products.update({
        id: b.id,
        expectedUpdatedAt: b.updatedAt.toISOString(),
        slug: a.slug,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "slug_taken" });
    const rows = await readAuditRows(fx.tenantId);
    const conflictRow = rows.find(
      (r) =>
        r.operation === "products.update" &&
        r.outcome === "failure" &&
        r.error === JSON.stringify({ code: "conflict" }),
    );
    expect(conflictRow).toBeTruthy();
  });

  it("owner + unknown id: NOT_FOUND + audit error 'not_found'", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });
    const phantom = randomUUID();

    await expect(
      appRouter.createCaller(ctx).products.update({
        id: phantom,
        expectedUpdatedAt: new Date().toISOString(),
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const rows = await readAuditRows(fx.tenantId);
    expect(rows).toContainEqual(
      expect.objectContaining({
        operation: "products.update",
        outcome: "failure",
        error: JSON.stringify({ code: "not_found" }),
      }),
    );
  });

  it("owner + cross-tenant id: SAME NOT_FOUND wire shape (existence-leak guard); audit lands under caller's tenant only", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fxA = await makeTenant();
    const fxB = await makeTenant();
    const { userId } = await makeUserAndMembership(fxA.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fxA, identityType: "session", userId, membershipRole: "owner" });
    const seededInB = await seedProductRow(fxB.tenantId);

    await expect(
      appRouter.createCaller(ctx).products.update({
        id: seededInB.id,
        expectedUpdatedAt: seededInB.updatedAt.toISOString(),
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const rowsB = await readAuditRows(fxB.tenantId);
    expect(rowsB.some((r) => r.operation === "products.update")).toBe(false);
  });

  it("products row tenant_id after update equals ctx.tenant.id (Low-02 wiring check)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });
    const seeded = await seedProductRow(fx.tenantId);

    await appRouter.createCaller(ctx).products.update({
      id: seeded.id,
      expectedUpdatedAt: seeded.updatedAt.toISOString(),
      status: "active",
    });
    const rows = await db.execute<{ tenant_id: string }>(
      sql`SELECT tenant_id::text AS tenant_id FROM products WHERE id = ${seeded.id}`,
    );
    const arr = Array.isArray(rows) ? rows : (rows as { rows?: Array<{ tenant_id: string }> }).rows ?? [];
    expect(arr[0]?.tenant_id).toBe(fx.tenantId);
  });
});

describe("productsRouter.get", () => {
  it("owner: returns Tier-B ProductOwner shape; no audit row (read)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });
    const seeded = await seedProductRow(fx.tenantId, { costPriceMinor: 77 });

    const out = await appRouter.createCaller(ctx).products.get({ id: seeded.id });
    expect(out).not.toBeNull();
    expect((out as unknown as { costPriceMinor: number | null }).costPriceMinor).toBe(77);

    const rows = await readAuditRows(fx.tenantId);
    expect(rows.some((r) => r.operation === "products.get")).toBe(false);
  });

  it("anonymous: UNAUTHORIZED on get", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });
    await expect(
      appRouter.createCaller(ctx).products.get({ id: randomUUID() }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("customer: FORBIDDEN on get", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const userId = randomUUID();
    await db.execute(sql`
      INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
      VALUES (${userId}, ${`c-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
    `);
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId });
    await expect(
      appRouter.createCaller(ctx).products.get({ id: randomUUID() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("owner + unknown id: returns null (caller maps to notFound())", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({ fixture: fx, identityType: "session", userId, membershipRole: "owner" });
    const out = await appRouter.createCaller(ctx).products.get({ id: randomUUID() });
    expect(out).toBeNull();
  });
});
