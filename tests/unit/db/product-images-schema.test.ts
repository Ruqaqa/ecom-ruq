/**
 * Chunk 1a.7.1 Block 1 sanity — product_images schema + migration 0012.
 *
 * Covers:
 *   - Drizzle insert + select + delete via withTenant (super-bypassed RLS;
 *     plumbing test only).
 *   - RLS denies cross-tenant SELECT under app_user.
 *   - Composite same-tenant FK on (tenant_id, product_id) rejects a row
 *     whose tenant disagrees with the parent product.
 *   - product_images_product_fingerprint_unique blocks per-product
 *     duplicates.
 *   - product_variants.cover_image_id ON DELETE SET NULL: when the
 *     referenced product_images row is purged, the variant's cover
 *     resets to null.
 *
 * Test-data isolation: each test allocates a fresh tenant via the super-
 * user pool (RLS bypass intentional — this is a schema test, not a
 * policy test). Cross-tenant policy semantics live in tenant-isolation.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq, and } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import {
  productImages,
  products,
  productVariants,
} from "@/server/db/schema/catalog";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import type { ImageDerivative } from "@/server/db/schema/_types";

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
  const slug = `img-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en',
      ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" })}'::jsonb`)}, 'active')
  `);
  return id;
}

async function makeProduct(tenantId: string): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `p-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)}, 'draft')
  `);
  return { id, slug };
}

function fingerprintFor(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

/**
 * Drizzle wraps Postgres errors as `Error("Failed query: ...")` with the
 * underlying postgres-js error attached via `cause`. Walk the chain to
 * the leaf and pull SQLSTATE + constraint name out of the structured
 * fields.
 */
function extractPgError(err: unknown): { code?: string; constraint_name?: string } {
  let cur: unknown = err;
  // Walk up to a few levels of cause.
  for (let depth = 0; depth < 8 && cur != null; depth++) {
    if (typeof cur === "object" && cur !== null) {
      const c = cur as { code?: unknown; constraint_name?: unknown; cause?: unknown };
      if (typeof c.code === "string") {
        const out: { code?: string; constraint_name?: string } = { code: c.code };
        if (typeof c.constraint_name === "string") {
          out.constraint_name = c.constraint_name;
        }
        return out;
      }
      cur = c.cause;
    } else {
      break;
    }
  }
  return {};
}

describe("product_images schema (chunk 1a.7.1 / migration 0012)", () => {
  it("Drizzle round-trip: insert + select + delete via withTenant", async () => {
    const tenantId = await makeTenant();
    const { id: productId, slug: productSlug } = await makeProduct(tenantId);
    const fingerprint = fingerprintFor(`${productId}-roundtrip`);
    const derivatives: ImageDerivative[] = [
      {
        size: "thumb",
        format: "webp",
        width: 200,
        height: 150,
        storageKey: `${tenantId.slice(0, 8)}/${productSlug}-0-v1-thumb.webp`,
        bytes: 1234,
      },
    ];

    const inserted = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      tx
        .insert(productImages)
        .values({
          tenantId,
          productId,
          position: 0,
          fingerprintSha256: fingerprint,
          storageKey: `${tenantId.slice(0, 8)}/${productSlug}-0-v1-original.jpg`,
          originalFormat: "jpeg",
          originalWidth: 1500,
          originalHeight: 1500,
          originalBytes: 248_010,
          derivatives,
        })
        .returning({ id: productImages.id, version: productImages.version }),
    );
    expect(inserted.length).toBe(1);
    expect(inserted[0]?.version).toBe(1);

    const rows = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      tx
        .select()
        .from(productImages)
        .where(eq(productImages.productId, productId)),
    );
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.fingerprintSha256).toBe(fingerprint);
    expect(row.derivatives).toEqual(derivatives);
    expect(row.originalWidth).toBe(1500);
    expect(row.position).toBe(0);
    expect(row.altText).toBeNull();

    await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      tx.delete(productImages).where(eq(productImages.id, inserted[0]!.id)),
    );
    const after = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      tx
        .select({ id: productImages.id })
        .from(productImages)
        .where(eq(productImages.productId, productId)),
    );
    expect(after.length).toBe(0);
  });

  it("RLS: app_user under tenant A cannot SELECT tenant B's image rows", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productB = await makeProduct(tenantB);
    // Seed tenant B's image as superuser (RLS bypass intentional for setup).
    await superDb.execute(sql`
      INSERT INTO product_images (tenant_id, product_id, position, fingerprint_sha256, storage_key,
        original_format, original_width, original_height, original_bytes)
      VALUES (${tenantB}, ${productB.id}, 0, ${fingerprintFor("rls-b")},
        ${"b/" + productB.slug + "-0-v1-original.jpg"}, 'jpeg', 1500, 1500, 1000)
    `);

    // Now run under app_user with tenant A's GUC.
    const seen = await superClient.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      const r = await tx<Array<{ id: string }>>`SELECT id FROM product_images`;
      return r.length;
    });
    expect(seen).toBe(0);
  });

  it("composite same-tenant FK rejects a tenant_id mismatch with parent product", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productInA = await makeProduct(tenantA);
    // Try to insert an image row in tenant B referencing a product in
    // tenant A. The composite FK on (tenant_id, product_id) requires
    // both to match, so this must blow up at the data layer.
    let caught: unknown = null;
    try {
      await superDb.execute(sql`
        INSERT INTO product_images (tenant_id, product_id, position, fingerprint_sha256, storage_key,
          original_format, original_width, original_height, original_bytes)
        VALUES (${tenantB}, ${productInA.id}, 0, ${fingerprintFor("xt-fk")},
          ${"x/leak-0-v1-original.jpg"}, 'jpeg', 1500, 1500, 1000)
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    // Drizzle wraps the Postgres error; the underlying pg error carries
    // SQLSTATE 23503 (foreign_key_violation) and the constraint name on
    // the `cause` chain. Wrapper message is opaque ("Failed query: ...").
    expect(extractPgError(caught)).toMatchObject({
      code: "23503",
      constraint_name: "product_images_product_same_tenant_fk",
    });
  });

  it("per-product fingerprint UNIQUE blocks duplicates of the same image bytes", async () => {
    const tenantId = await makeTenant();
    const { id: productId, slug: productSlug } = await makeProduct(tenantId);
    const fp = fingerprintFor(`${productId}-dup`);

    await superDb.execute(sql`
      INSERT INTO product_images (tenant_id, product_id, position, fingerprint_sha256, storage_key,
        original_format, original_width, original_height, original_bytes)
      VALUES (${tenantId}, ${productId}, 0, ${fp},
        ${"k/" + productSlug + "-0-v1-original.jpg"}, 'jpeg', 1500, 1500, 1000)
    `);

    let caught: unknown = null;
    try {
      await superDb.execute(sql`
        INSERT INTO product_images (tenant_id, product_id, position, fingerprint_sha256, storage_key,
          original_format, original_width, original_height, original_bytes)
        VALUES (${tenantId}, ${productId}, 1, ${fp},
          ${"k/" + productSlug + "-1-v1-original.jpg"}, 'jpeg', 1500, 1500, 1000)
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(extractPgError(caught)).toMatchObject({
      code: "23505",
      constraint_name: "product_images_product_fingerprint_unique",
    });
  });

  it("product_variants.cover_image_id resets to NULL when the referenced image is deleted", async () => {
    const tenantId = await makeTenant();
    const { id: productId, slug: productSlug } = await makeProduct(tenantId);

    // Seed an image and a variant pointing at it.
    const imageId = randomUUID();
    await superDb.execute(sql`
      INSERT INTO product_images (id, tenant_id, product_id, position, fingerprint_sha256, storage_key,
        original_format, original_width, original_height, original_bytes)
      VALUES (${imageId}, ${tenantId}, ${productId}, 0, ${fingerprintFor("cov-set-null")},
        ${"k/" + productSlug + "-0-v1-original.jpg"}, 'jpeg', 1500, 1500, 1000)
    `);
    const variantId = randomUUID();
    await superDb.execute(sql`
      INSERT INTO product_variants (id, tenant_id, product_id, sku, price_minor, cover_image_id)
      VALUES (${variantId}, ${tenantId}, ${productId}, ${"sku-" + variantId.slice(0, 8)}, 9900, ${imageId})
    `);

    // Sanity: variant carries the cover.
    const before = await superDb
      .select({ coverImageId: productVariants.coverImageId })
      .from(productVariants)
      .where(eq(productVariants.id, variantId));
    expect(before[0]?.coverImageId).toBe(imageId);

    // Delete the image; variant cover must reset to NULL via the FK action.
    await superDb.delete(productImages).where(eq(productImages.id, imageId));

    const after = await superDb
      .select({ coverImageId: productVariants.coverImageId })
      .from(productVariants)
      .where(eq(productVariants.id, variantId));
    expect(after[0]?.coverImageId).toBeNull();
  });

  it("composite same-tenant FK on cover_image_id rejects cross-tenant references", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productInA = await makeProduct(tenantA);
    const productInB = await makeProduct(tenantB);

    // Seed an image under tenant A.
    const imageInAId = randomUUID();
    await superDb.execute(sql`
      INSERT INTO product_images (id, tenant_id, product_id, position, fingerprint_sha256, storage_key,
        original_format, original_width, original_height, original_bytes)
      VALUES (${imageInAId}, ${tenantA}, ${productInA.id}, 0, ${fingerprintFor("xt-cov")},
        ${"a/" + productInA.slug + "-0-v1-original.jpg"}, 'jpeg', 1500, 1500, 1000)
    `);

    // A variant in tenant B trying to point at a tenant-A image must fail.
    let caught: unknown = null;
    try {
      await superDb.execute(sql`
        INSERT INTO product_variants (tenant_id, product_id, sku, price_minor, cover_image_id)
        VALUES (${tenantB}, ${productInB.id}, ${"sku-leak-" + randomUUID().slice(0, 8)}, 9900, ${imageInAId})
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(extractPgError(caught)).toMatchObject({
      code: "23503",
      constraint_name: "product_variants_cover_image_same_tenant_fk",
    });
  });

  it("product DELETE cascades to product_images via composite FK", async () => {
    const tenantId = await makeTenant();
    const { id: productId, slug: productSlug } = await makeProduct(tenantId);
    await superDb.execute(sql`
      INSERT INTO product_images (tenant_id, product_id, position, fingerprint_sha256, storage_key,
        original_format, original_width, original_height, original_bytes)
      VALUES
        (${tenantId}, ${productId}, 0, ${fingerprintFor("cascade-0")},
          ${"k/" + productSlug + "-0-v1-original.jpg"}, 'jpeg', 1500, 1500, 1000),
        (${tenantId}, ${productId}, 1, ${fingerprintFor("cascade-1")},
          ${"k/" + productSlug + "-1-v1-original.jpg"}, 'jpeg', 1500, 1500, 1000)
    `);

    await superDb
      .delete(products)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)));

    const remaining = await superDb
      .select({ id: productImages.id })
      .from(productImages)
      .where(eq(productImages.productId, productId));
    expect(remaining.length).toBe(0);
  });
});
