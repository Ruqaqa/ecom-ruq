/**
 * `productsRouter.setOptions` cascade audit behaviour — chunk 1a.5.3.
 *
 * The 1a.5.3 cascade (omit an option type → cascade-delete every variant
 * referencing it, single-tx, advisory-locked) MUST produce exactly ONE
 * audit row per call — the options-side row, with `cascadedVariantIds`
 * populated. Not two rows. Not N+1 rows. Prevents a regression where a
 * future refactor double-writes the variant-side audit chain off the
 * cascade path.
 *
 * Security spec §9.2 (audit-row-presence test).
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
  const slug = `vc-router-${id.slice(0, 8)}`;
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
  membershipRole?: "owner" | "staff" | "support";
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
      : {
          type: "session" as const,
          userId: opts.userId!,
          sessionId: "s_" + opts.userId,
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

async function readAuditRows(
  tenantId: string,
): Promise<
  Array<{
    outcome: string;
    operation: string;
    error: string | null;
    correlation_id: string;
  }>
> {
  const rows = await db.execute<{
    outcome: string;
    operation: string;
    error: string | null;
    correlation_id: string;
  }>(
    sql`SELECT outcome, operation, error, correlation_id::text AS correlation_id
        FROM audit_log
        WHERE tenant_id = ${tenantId}::uuid
        ORDER BY created_at ASC`,
  );
  if (Array.isArray(rows)) return rows as never;
  const unwrapped = (rows as { rows?: typeof rows }).rows;
  return (
    (unwrapped as unknown as Array<{
      outcome: string;
      operation: string;
      error: string | null;
      correlation_id: string;
    }>) ?? []
  );
}

/**
 * Reads the `after` audit_payloads row for one correlation_id. Used to
 * confirm the cascadedVariantIds field actually persists into the
 * append-only chain — not just into the wire response.
 */
async function readAfterPayload(
  tenantId: string,
  correlationId: string,
): Promise<unknown> {
  const rows = await db.execute<{ payload: unknown }>(
    sql`SELECT payload
        FROM audit_payloads
        WHERE tenant_id = ${tenantId}::uuid
          AND correlation_id = ${correlationId}::uuid
          AND kind = 'after'
        LIMIT 1`,
  );
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ payload: unknown }> }).rows ?? []);
  return arr[0]?.payload ?? null;
}

const colorEnAr = { en: "Color", ar: "اللون" };
const sizeEnAr = { en: "Size", ar: "المقاس" };

describe("productsRouter.setOptions — cascade audit-row presence (1a.5.3)", () => {
  it("a cascade-removal call produces exactly ONE audit row scoped to the tenant (operation = products.setOptions)", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });

    // 1. Create a product.
    const created = await appRouter.createCaller(ctx).products.create({
      slug: `p-${randomUUID().slice(0, 8)}`,
      name: { en: "Pen", ar: "قلم" },
    });

    // 2. Define two option types with two values each.
    const optsResult = await appRouter
      .createCaller(ctx)
      .products.setOptions({
        productId: created.id,
        expectedUpdatedAt: created.updatedAt.toISOString(),
        options: [
          {
            name: colorEnAr,
            values: [
              { value: { en: "Red", ar: "أحمر" } },
              { value: { en: "Blue", ar: "أزرق" } },
            ],
          },
          {
            name: sizeEnAr,
            values: [
              { value: { en: "Small", ar: "صغير" } },
              { value: { en: "Medium", ar: "وسط" } },
            ],
          },
        ],
      });
    const colorOption = optsResult.options[0]!;
    const sizeOption = optsResult.options[1]!;

    // 3. Define four variants (full cartesian).
    const variantsResult = await appRouter
      .createCaller(ctx)
      .products.setVariants({
        productId: created.id,
        expectedUpdatedAt: optsResult.productUpdatedAt.toISOString(),
        variants: [
          {
            sku: `c1-${randomUUID().slice(0, 6)}`,
            priceMinor: 100,
            stock: 0,
            optionValueIds: [
              colorOption.values[0]!.id,
              sizeOption.values[0]!.id,
            ],
          },
          {
            sku: `c2-${randomUUID().slice(0, 6)}`,
            priceMinor: 200,
            stock: 0,
            optionValueIds: [
              colorOption.values[0]!.id,
              sizeOption.values[1]!.id,
            ],
          },
          {
            sku: `c3-${randomUUID().slice(0, 6)}`,
            priceMinor: 300,
            stock: 0,
            optionValueIds: [
              colorOption.values[1]!.id,
              sizeOption.values[0]!.id,
            ],
          },
          {
            sku: `c4-${randomUUID().slice(0, 6)}`,
            priceMinor: 400,
            stock: 0,
            optionValueIds: [
              colorOption.values[1]!.id,
              sizeOption.values[1]!.id,
            ],
          },
        ],
      });

    // Snapshot audit-row count BEFORE the cascade call.
    const before = await readAuditRows(fx.tenantId);
    const beforeCount = before.length;

    // 4. The CASCADE call — drop the Color option type. All four
    //    variant rows must hard-delete.
    const cascade = await appRouter
      .createCaller(ctx)
      .products.setOptions({
        productId: created.id,
        expectedUpdatedAt: variantsResult.productUpdatedAt.toISOString(),
        options: [
          {
            id: sizeOption.id,
            name: sizeEnAr,
            values: [
              { id: sizeOption.values[0]!.id, value: { en: "Small", ar: "صغير" } },
              { id: sizeOption.values[1]!.id, value: { en: "Medium", ar: "وسط" } },
            ],
          },
        ],
      });
    expect(cascade.cascadedVariantIds.length).toBe(4);

    // 5. EXACTLY ONE new audit row per cascade call.
    const after = await readAuditRows(fx.tenantId);
    expect(after.length).toBe(beforeCount + 1);

    const newRow = after[after.length - 1]!;
    expect(newRow.operation).toBe("products.setOptions");
    expect(newRow.outcome).toBe("success");
    expect(newRow.error).toBeNull();

    // 6. Sanity: variants rows are gone on disk, but no separate
    //    "products.setVariants" audit row was written off the cascade
    //    path.
    const cascadeRows = after.filter(
      (r) => r.operation === "products.setVariants",
    );
    const cascadeCountBefore = before.filter(
      (r) => r.operation === "products.setVariants",
    ).length;
    expect(cascadeRows.length).toBe(cascadeCountBefore);
  });

  it("the persisted `after` payload carries cascadedVariantIds matching the wire response (architect §1/§6 — closes the audit-trail loop)", async () => {
    // Spec gap closer: the previous test confirms a single audit row
    // per cascade. This one joins through to audit_payloads and asserts
    // the `after` payload's `cascadedVariantIds` matches the wire
    // response's sorted set — proving the cascaded ids actually
    // persist into the append-only chain, not just into the wire body.
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });

    // Seed a product with one option (Color × {Red, Blue}) and two
    // variants — one per Color value. Smaller seed than the prior test
    // because we only need a deterministic non-empty cascade set.
    const created = await appRouter.createCaller(ctx).products.create({
      slug: `p-${randomUUID().slice(0, 8)}`,
      name: { en: "Pad", ar: "دفتر" },
    });
    const optsResult = await appRouter
      .createCaller(ctx)
      .products.setOptions({
        productId: created.id,
        expectedUpdatedAt: created.updatedAt.toISOString(),
        options: [
          {
            name: colorEnAr,
            values: [
              { value: { en: "Red", ar: "أحمر" } },
              { value: { en: "Blue", ar: "أزرق" } },
            ],
          },
        ],
      });
    const colorOption = optsResult.options[0]!;
    const variantsResult = await appRouter
      .createCaller(ctx)
      .products.setVariants({
        productId: created.id,
        expectedUpdatedAt: optsResult.productUpdatedAt.toISOString(),
        variants: [
          {
            sku: `r-${randomUUID().slice(0, 6)}`,
            priceMinor: 100,
            stock: 0,
            optionValueIds: [colorOption.values[0]!.id],
          },
          {
            sku: `b-${randomUUID().slice(0, 6)}`,
            priceMinor: 200,
            stock: 0,
            optionValueIds: [colorOption.values[1]!.id],
          },
        ],
      });

    // Cascade — drop the only option type; both variants must hard-
    // delete and the audit `after` payload must carry both ids.
    const beforeRows = await readAuditRows(fx.tenantId);
    const cascade = await appRouter.createCaller(ctx).products.setOptions({
      productId: created.id,
      expectedUpdatedAt: variantsResult.productUpdatedAt.toISOString(),
      options: [],
    });
    expect(cascade.cascadedVariantIds.length).toBe(2);
    const expectedSorted = [...cascade.cascadedVariantIds].sort();
    expect(cascade.cascadedVariantIds).toEqual(expectedSorted);

    // Find the new audit row by ID list diff — that gives us the
    // correlation_id of the cascade call.
    const afterRows = await readAuditRows(fx.tenantId);
    const beforeCorrelations = new Set(
      beforeRows.map((r) => r.correlation_id),
    );
    const newRow = afterRows.find(
      (r) =>
        !beforeCorrelations.has(r.correlation_id) &&
        r.operation === "products.setOptions",
    );
    expect(newRow).toBeDefined();

    // Pull the `after` payload row by correlation_id and assert the
    // cascadedVariantIds field landed in the append-only chain.
    const persisted = (await readAfterPayload(
      fx.tenantId,
      newRow!.correlation_id,
    )) as { cascadedVariantIds?: string[] } | null;
    expect(persisted).not.toBeNull();
    expect(persisted!.cascadedVariantIds).toBeDefined();
    expect(persisted!.cascadedVariantIds).toEqual(expectedSorted);

    // Audit-bounding sanity — the persisted `after` payload should not
    // carry SKU strings or localized JSONB. (PDPL guard preserved on
    // the new field.)
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toMatch(/"sku"/);
    expect(serialized).not.toMatch(/"name"/);
    // Note: `"value"` quoted-key check is intentionally skipped here —
    // the audit_payloads `payload` column is itself a `payload` value
    // wrapper in some adapter shapes; the helper-level guard at
    // tests/unit/services/variants/audit-snapshot.test.ts is the
    // authoritative shape lock.
  });
});
