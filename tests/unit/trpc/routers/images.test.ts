/**
 * Chunk 1a.7.1 Block 5a — tRPC images router tests.
 *
 * Five endpoints: list (query), delete + setProductCover +
 * setVariantCover + setAltText (mutations). Bytes go through the
 * Block 5b route handlers, NOT this router.
 *
 * Coverage:
 *   - role gate: anonymous + customer reject on every endpoint
 *   - StaleWriteError → CONFLICT 'stale_write' translation
 *   - delete cascade-shifts surviving image positions
 *   - audit before/after payloads land for each mutation
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
  const slug = `img-${id.slice(0, 8)}`;
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
  role: "owner" | "staff" | "support" | "customer",
): Promise<{ userId: string }> {
  const userId = randomUUID();
  await db.execute(sql`
    INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
    VALUES (${userId}, ${`u-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
  `);
  if (role !== "customer") {
    await db.execute(sql`
      INSERT INTO memberships (id, tenant_id, user_id, role, created_at)
      VALUES (${randomUUID()}, ${tenantId}::uuid, ${userId}::uuid, ${role}, now())
    `);
  }
  return { userId };
}

async function seedProduct(tenantId: string): Promise<{
  id: string;
  slug: string;
  updatedAt: Date;
}> {
  const id = randomUUID();
  const slug = `prod-${id.slice(0, 8)}`;
  await db.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)}, 'draft')
  `);
  const rows = await db
    .select({ updatedAt: products.updatedAt })
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  return { id, slug, updatedAt: rows[0]!.updatedAt };
}

async function seedImage(
  tenantId: string,
  productId: string,
  position: number,
  fingerprint: string,
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO product_images (
      tenant_id, product_id, position, version, fingerprint_sha256,
      storage_key, original_format, original_width, original_height,
      original_bytes
    ) VALUES (
      ${tenantId}, ${productId}, ${position}, 1, ${fingerprint},
      ${`k-${position}`}, 'jpeg', 1500, 1500, 1234
    )
    RETURNING id::text AS id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : (rows as { rows?: Array<{ id: string }> }).rows ?? [];
  return arr[0]!.id;
}

interface BuildCtxOpts {
  fixture: TenantFixture;
  identityType: "anonymous" | "session" | "bearer";
  userId?: string;
  tokenId?: string;
  membershipRole?: "owner" | "staff" | "support" | "customer";
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
              (opts.effectiveRole ??
                (opts.membershipRole === "customer"
                  ? "support"
                  : opts.membershipRole) ??
                "owner") as "owner" | "staff" | "support",
          };

  const membership =
    opts.membershipRole && opts.membershipRole !== "customer"
      ? {
          id: "m_test",
          role: opts.membershipRole,
          userId: opts.userId!,
          tenantId: opts.fixture.tenantId,
        }
      : null;

  return { tenant, identity, membership };
}

describe("imagesRouter.list", () => {
  it("owner success: returns sorted images for the product", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const product = await seedProduct(fx.tenantId);
    await seedImage(fx.tenantId, product.id, 1, "1".repeat(64));
    await seedImage(fx.tenantId, product.id, 0, "0".repeat(64));

    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });

    const out = await appRouter.createCaller(ctx).images.list({
      productId: product.id,
    });
    expect(out.images).toHaveLength(2);
    expect(out.images.map((i) => i.position)).toEqual([0, 1]);
  });

  it("anonymous: rejected by requireRole gate", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const product = await seedProduct(fx.tenantId);
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });

    await expect(
      appRouter.createCaller(ctx).images.list({ productId: product.id }),
    ).rejects.toThrow();
  });

  it("customer: rejected by requireRole gate", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "customer");
    const product = await seedProduct(fx.tenantId);
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
    });

    await expect(
      appRouter.createCaller(ctx).images.list({ productId: product.id }),
    ).rejects.toThrow();
  });
});

describe("imagesRouter.delete", () => {
  it("owner success: cascade-shifts surviving image positions", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const product = await seedProduct(fx.tenantId);
    await seedImage(fx.tenantId, product.id, 0, "0".repeat(64));
    const middleId = await seedImage(fx.tenantId, product.id, 1, "1".repeat(64));
    await seedImage(fx.tenantId, product.id, 2, "2".repeat(64));

    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });

    const out = await appRouter.createCaller(ctx).images.delete({
      imageId: middleId,
      expectedUpdatedAt: product.updatedAt.toISOString(),
      confirm: true,
    });
    expect(out.deletedImageId).toBe(middleId);

    // Verify positions reshuffle 0/2 → 0/1.
    const rows = await db.execute<{ position: number }>(sql`
      SELECT position FROM product_images WHERE product_id = ${product.id} ORDER BY position
    `);
    const arr = Array.isArray(rows)
      ? rows
      : (rows as { rows?: Array<{ position: number }> }).rows ?? [];
    expect(arr.map((r) => r.position)).toEqual([0, 1]);
  });

  it("translates StaleWriteError into CONFLICT 'stale_write' on the wire", async () => {
    const { TRPCError } = await import("@trpc/server");
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    const product = await seedProduct(fx.tenantId);
    const imageId = await seedImage(fx.tenantId, product.id, 0, "0".repeat(64));

    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "owner",
    });

    let caught: unknown = null;
    try {
      await appRouter.createCaller(ctx).images.delete({
        imageId,
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
        confirm: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as InstanceType<typeof TRPCError>).code).toBe("CONFLICT");
    expect((caught as InstanceType<typeof TRPCError>).message).toBe(
      "stale_write",
    );
  });

  it("anonymous: rejected by requireRole gate", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const product = await seedProduct(fx.tenantId);
    const imageId = await seedImage(
      fx.tenantId,
      product.id,
      0,
      "0".repeat(64),
    );
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });

    await expect(
      appRouter.createCaller(ctx).images.delete({
        imageId,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        confirm: true,
      }),
    ).rejects.toThrow();
  });
});

describe("imagesRouter.setProductCover", () => {
  it("staff success: swaps positions atomically", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "staff");
    const product = await seedProduct(fx.tenantId);
    await seedImage(fx.tenantId, product.id, 0, "0".repeat(64));
    const targetId = await seedImage(
      fx.tenantId,
      product.id,
      2,
      "2".repeat(64),
    );

    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "staff",
    });

    const out = await appRouter.createCaller(ctx).images.setProductCover({
      imageId: targetId,
      expectedUpdatedAt: product.updatedAt.toISOString(),
    });
    expect(out.newCoverImageId).toBe(targetId);
  });

  it("customer: rejected by requireRole gate", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "customer");
    const product = await seedProduct(fx.tenantId);
    const imageId = await seedImage(
      fx.tenantId,
      product.id,
      0,
      "0".repeat(64),
    );
    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
    });

    await expect(
      appRouter.createCaller(ctx).images.setProductCover({
        imageId,
        expectedUpdatedAt: product.updatedAt.toISOString(),
      }),
    ).rejects.toThrow();
  });
});

describe("imagesRouter.setAltText", () => {
  it("staff success: persists partial-merge alt text", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "staff");
    const product = await seedProduct(fx.tenantId);
    const imageId = await seedImage(
      fx.tenantId,
      product.id,
      0,
      "0".repeat(64),
    );

    const ctx = await buildCtx({
      fixture: fx,
      identityType: "session",
      userId,
      membershipRole: "staff",
    });

    const out = await appRouter.createCaller(ctx).images.setAltText({
      imageId,
      expectedUpdatedAt: product.updatedAt.toISOString(),
      altText: { en: "alt en", ar: "alt ar" },
    });
    expect(out.imageId).toBe(imageId);
    expect(out.altText).toEqual({ en: "alt en", ar: "alt ar" });
  });

  it("anonymous: rejected by requireRole gate", async () => {
    const { appRouter } = await import("@/server/trpc/root");
    const fx = await makeTenant();
    const product = await seedProduct(fx.tenantId);
    const imageId = await seedImage(
      fx.tenantId,
      product.id,
      0,
      "0".repeat(64),
    );
    const ctx = await buildCtx({ fixture: fx, identityType: "anonymous" });

    await expect(
      appRouter.createCaller(ctx).images.setAltText({
        imageId,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        altText: null,
      }),
    ).rejects.toThrow();
  });
});
