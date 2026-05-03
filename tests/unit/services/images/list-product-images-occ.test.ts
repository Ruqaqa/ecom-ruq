/**
 * `listProductImages` OCC token tests (chunk 1a.7.2 Block 6c).
 *
 * The list service returns `productUpdatedAt: string | null` so the
 * admin photo UI can use it as the OCC token for cover/alt/replace
 * mutations on the parent product. Cases:
 *   1. Visible product with images → ISO datetime string.
 *   2. Visible product with zero images → still a string (token is
 *      independent of image rows).
 *   3. Cross-tenant → null (RLS hides the product).
 *   4. Soft-deleted product → null (`deleted_at IS NOT NULL` filter).
 */
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "@/server/db";
import { listProductImages } from "@/server/services/images/list-product-images";
import {
  ctxFor,
  makeTenant,
  seedProduct,
  superClient,
  superDb,
} from "./_helpers";

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function seedImage(
  tenantId: string,
  productId: string,
  position: number,
  fingerprint: string,
): Promise<void> {
  await superDb.execute(sql`
    INSERT INTO product_images (
      tenant_id, product_id, position, version, fingerprint_sha256,
      storage_key, original_format, original_width, original_height,
      original_bytes, derivatives, alt_text
    ) VALUES (
      ${tenantId}, ${productId}, ${position}, 1, ${fingerprint},
      ${`k-${position}`}, 'jpeg', 1500, 1500, 1234,
      '[]'::jsonb, NULL
    )
  `);
}

describe("listProductImages — productUpdatedAt OCC token", () => {
  it("returns the product's updated_at as an ISO string when visible with images", async () => {
    const tenant = await makeTenant("img-occ");
    const product = await seedProduct(tenant.id);
    await seedImage(tenant.id, product.id, 0, "0".repeat(64));

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      listProductImages(tx, { id: tenant.id }, "owner", {
        productId: product.id,
      }),
    );

    expect(result.images).toHaveLength(1);
    expect(result.productUpdatedAt).toBeTypeOf("string");
    // ISO-8601 datetime — never empty string.
    expect(result.productUpdatedAt!.length).toBeGreaterThan(0);
    expect(() => new Date(result.productUpdatedAt!).toISOString()).not.toThrow();
  });

  it("returns the OCC token even when the product has zero images", async () => {
    const tenant = await makeTenant("img-occ");
    const product = await seedProduct(tenant.id);

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      listProductImages(tx, { id: tenant.id }, "staff", {
        productId: product.id,
      }),
    );

    expect(result.images).toEqual([]);
    expect(result.productUpdatedAt).toBeTypeOf("string");
    expect(result.productUpdatedAt!.length).toBeGreaterThan(0);
  });

  it("returns null productUpdatedAt for a cross-tenant product", async () => {
    const tenantA = await makeTenant("img-occ-a");
    const tenantB = await makeTenant("img-occ-b");
    const productB = await seedProduct(tenantB.id);

    // Tenant A asks for tenant B's product id — cross-tenant invisible.
    const result = await withTenant(superDb, ctxFor(tenantA.id), (tx) =>
      listProductImages(tx, { id: tenantA.id }, "owner", {
        productId: productB.id,
      }),
    );

    expect(result.images).toEqual([]);
    expect(result.productUpdatedAt).toBeNull();
  });

  it("returns null productUpdatedAt for a soft-deleted product", async () => {
    const tenant = await makeTenant("img-occ");
    const product = await seedProduct(tenant.id);
    await superDb.execute(sql`
      UPDATE products
      SET deleted_at = now()
      WHERE id = ${product.id}
    `);

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      listProductImages(tx, { id: tenant.id }, "owner", {
        productId: product.id,
      }),
    );

    expect(result.productUpdatedAt).toBeNull();
  });
});
