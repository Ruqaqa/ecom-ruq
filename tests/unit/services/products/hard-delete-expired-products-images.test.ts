/**
 * Chunk 1a.7.1 Block 7 — hard-purge cleanup hook for product images.
 *
 * When the recovery-window sweeper hard-deletes a product, every image's
 * original file AND every derivative file under it is best-effort
 * purged from the storage adapter. Storage failures are logged to
 * Sentry and NEVER thrown — the DB row purge stays atomic.
 *
 * Implementation note (per architect's brief):
 *   - The DB CASCADE on the composite same-tenant FK already removes
 *     `product_images` rows when a product row is deleted. Storage is
 *     a separate concern; this test is the integration point.
 *   - No job runner exists in 1a.7.1 — failed deletes are surfaced via
 *     Sentry "product_purge_storage_orphan" until Phase 1b's job runner
 *     ships. Manual operator cleanup until then.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { productImages } from "@/server/db/schema/catalog";
import { withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { LocalDiskStorageAdapter } from "@/server/storage/local-disk";
import {
  __setSentryForTests,
  type SentryLike,
} from "@/server/obs/sentry";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const superClient = postgres(DATABASE_URL, { max: 4 });
const superDb = drizzle(superClient, { schema });

let tempStorageDir: string;
let adapter: LocalDiskStorageAdapter;

beforeEach(() => {
  tempStorageDir = mkdtempSync(join(tmpdir(), "ecom-ruq-hd-"));
  adapter = new LocalDiskStorageAdapter(tempStorageDir);
});

afterEach(() => {
  rmSync(tempStorageDir, { recursive: true, force: true });
  __setSentryForTests(null);
});

async function makeTenant(): Promise<string> {
  const id = randomUUID();
  const slug = `hd-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${slug + ".local"}, 'en',
      ${"no-reply@" + slug + ".local"},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" })}'::jsonb`)}, 'active')
  `);
  return id;
}

async function seedExpired(
  tenantId: string,
  daysAgo: number,
): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = `hd-${id.slice(0, 8)}`;
  await superDb.execute(sql`
    INSERT INTO products (id, tenant_id, slug, name, status, deleted_at)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)},
      'draft', now() - (${daysAgo}::int || ' days')::interval)
  `);
  return { id, slug };
}

async function seedImageWithFiles(
  tenantId: string,
  productId: string,
  productSlug: string,
  position: number,
): Promise<{
  id: string;
  originalKey: string;
  derivativeKeys: string[];
}> {
  const id = randomUUID();
  const originalKey = `t/${productSlug}-${position}-v1-original.jpg`;
  const derivativeKeys = [
    `t/${productSlug}-${position}-v1-thumb.webp`,
    `t/${productSlug}-${position}-v1-card.webp`,
  ];
  await adapter.put(originalKey, Buffer.from("orig"), "image/jpeg");
  for (const k of derivativeKeys) {
    await adapter.put(k, Buffer.from("deriv"), "image/webp");
  }
  await superDb.execute(sql`
    INSERT INTO product_images (id, tenant_id, product_id, position, fingerprint_sha256,
      storage_key, original_format, original_width, original_height, original_bytes, derivatives)
    VALUES (${id}, ${tenantId}, ${productId}, ${position},
      ${id.replace(/-/g, "")},
      ${originalKey}, 'jpeg', 1500, 1500, 1000,
      ${sql.raw(
        `'${JSON.stringify(
          derivativeKeys.map((storageKey) => ({
            size: "thumb",
            format: "webp",
            width: 200,
            height: 150,
            storageKey,
            bytes: 5,
          })),
        ).replace(/'/g, "''")}'::jsonb`,
      )})
  `);
  return { id, originalKey, derivativeKeys };
}

function ctxFor(tenantId: string) {
  return buildAuthedTenantContext(
    { id: tenantId },
    { userId: null, actorType: "anonymous", tokenId: null, role: "anonymous" },
  );
}

describe("hardDeleteExpiredProducts — image cleanup hook (chunk 1a.7.1 Block 7)", () => {
  it("purges original + derivative files for every expired product image", async () => {
    const { hardDeleteExpiredProducts } = await import(
      "@/server/services/products/hard-delete-expired-products"
    );
    const tenantId = await makeTenant();
    const expiredProduct = await seedExpired(tenantId, 35);

    const img1 = await seedImageWithFiles(
      tenantId,
      expiredProduct.id,
      expiredProduct.slug,
      0,
    );
    const img2 = await seedImageWithFiles(
      tenantId,
      expiredProduct.id,
      expiredProduct.slug,
      1,
    );

    // Sanity: files exist before purge.
    expect(await adapter.get(img1.originalKey)).not.toBeNull();
    for (const k of img1.derivativeKeys) {
      expect(await adapter.get(k)).not.toBeNull();
    }

    const out = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredProducts(
        tx,
        { id: tenantId },
        "owner",
        { dryRun: false, confirm: true },
        { storage: adapter },
      ),
    );
    expect(out.count).toBe(1);
    expect(out.ids).toEqual([expiredProduct.id]);

    // Row gone via FK cascade.
    const remaining = await superDb
      .select({ id: productImages.id })
      .from(productImages)
      .where(eq(productImages.productId, expiredProduct.id));
    expect(remaining.length).toBe(0);

    // Files gone too.
    expect(await adapter.get(img1.originalKey)).toBeNull();
    expect(await adapter.get(img2.originalKey)).toBeNull();
    for (const k of [...img1.derivativeKeys, ...img2.derivativeKeys]) {
      expect(await adapter.get(k)).toBeNull();
    }
  });

  it("dryRun does not touch files", async () => {
    const { hardDeleteExpiredProducts } = await import(
      "@/server/services/products/hard-delete-expired-products"
    );
    const tenantId = await makeTenant();
    const expiredProduct = await seedExpired(tenantId, 35);
    const img = await seedImageWithFiles(
      tenantId,
      expiredProduct.id,
      expiredProduct.slug,
      0,
    );

    const out = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredProducts(
        tx,
        { id: tenantId },
        "owner",
        { dryRun: true, confirm: true },
        { storage: adapter },
      ),
    );
    expect(out.dryRun).toBe(true);
    expect(out.count).toBe(1);

    // Files untouched.
    expect(await adapter.get(img.originalKey)).not.toBeNull();
    for (const k of img.derivativeKeys) {
      expect(await adapter.get(k)).not.toBeNull();
    }
  });

  it(
    "storage delete failures are best-effort — DB purge still succeeds; orphan logged to Sentry",
    async () => {
      const { hardDeleteExpiredProducts } = await import(
        "@/server/services/products/hard-delete-expired-products"
      );
      const tenantId = await makeTenant();
      const expiredProduct = await seedExpired(tenantId, 35);
      await seedImageWithFiles(
        tenantId,
        expiredProduct.id,
        expiredProduct.slug,
        0,
      );

      const sentryCalls: Array<{ name: string; opts?: unknown }> = [];
      const fakeSentry: SentryLike = {
        captureMessage(name, options) {
          sentryCalls.push({ name, opts: options });
        },
      };
      __setSentryForTests(fakeSentry);

      // Adapter that always throws on delete.
      const failingAdapter = {
        put: adapter.put.bind(adapter),
        get: adapter.get.bind(adapter),
        delete: async () => {
          throw new Error("simulated storage backend down");
        },
      };

      const out = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
        hardDeleteExpiredProducts(
          tx,
          { id: tenantId },
          "owner",
          { dryRun: false, confirm: true },
          { storage: failingAdapter },
        ),
      );
      expect(out.count).toBe(1);

      // DB row STILL gone (cascade).
      const remaining = await superDb
        .select({ id: productImages.id })
        .from(productImages)
        .where(eq(productImages.productId, expiredProduct.id));
      expect(remaining.length).toBe(0);

      // Orphan signal logged to Sentry.
      const orphan = sentryCalls.find(
        (c) => c.name === "product_purge_storage_orphan",
      );
      expect(orphan).toBeDefined();
    },
  );

  it("works when the expired product has no images (no-op on storage path)", async () => {
    const { hardDeleteExpiredProducts } = await import(
      "@/server/services/products/hard-delete-expired-products"
    );
    const tenantId = await makeTenant();
    const expiredProduct = await seedExpired(tenantId, 35);

    const out = await withTenant(superDb, ctxFor(tenantId), async (tx) =>
      hardDeleteExpiredProducts(
        tx,
        { id: tenantId },
        "owner",
        { dryRun: false, confirm: true },
        { storage: adapter },
      ),
    );
    expect(out.count).toBe(1);
    expect(out.ids).toEqual([expiredProduct.id]);
  });
});
