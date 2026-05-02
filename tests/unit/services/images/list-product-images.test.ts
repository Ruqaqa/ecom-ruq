/**
 * `listProductImages` integration tests (chunk 1a.7.1 Block 4).
 *
 * Read service — no audit, no advisory lock. Defense-in-depth role
 * gate refuses non-admin callers (transport layer is the primary
 * gate; this guards against wiring bugs).
 */
import { describe, it, expect, afterAll } from "vitest";
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
import type { Role } from "@/server/tenant/context";

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

async function seedImage(
  tenantId: string,
  productId: string,
  position: number,
  fingerprint: string,
): Promise<string> {
  const rows = await superDb.execute<{ id: string }>(sql`
    INSERT INTO product_images (
      tenant_id, product_id, position, version, fingerprint_sha256,
      storage_key, original_format, original_width, original_height,
      original_bytes, derivatives, alt_text
    ) VALUES (
      ${tenantId}, ${productId}, ${position}, 1, ${fingerprint},
      ${`k-${position}`}, 'jpeg', 1500, 1500, 1234,
      '[]'::jsonb, NULL
    )
    RETURNING id::text AS id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ id: string }> }).rows ?? []);
  return arr[0]!.id;
}

describe("listProductImages", () => {
  it("returns an empty array for a product with no images", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      listProductImages(tx, { id: tenant.id }, "owner", {
        productId: product.id,
      }),
    );

    expect(result.productId).toBe(product.id);
    expect(result.images).toEqual([]);
  });

  it("returns images sorted by position ASC", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    await seedImage(tenant.id, product.id, 2, "f".repeat(64));
    await seedImage(tenant.id, product.id, 0, "0".repeat(64));
    await seedImage(tenant.id, product.id, 1, "1".repeat(64));

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      listProductImages(tx, { id: tenant.id }, "staff", {
        productId: product.id,
      }),
    );

    expect(result.images).toHaveLength(3);
    expect(result.images.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it("does not leak images from other tenants (cross-tenant scope)", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const productA = await seedProduct(tenantA.id);
    const productB = await seedProduct(tenantB.id);
    await seedImage(tenantA.id, productA.id, 0, "a".repeat(64));
    await seedImage(tenantB.id, productB.id, 0, "b".repeat(64));

    // Tenant A asks for tenant B's product id — gets empty (RLS +
    // tenantId scope filters).
    const result = await withTenant(superDb, ctxFor(tenantA.id), (tx) =>
      listProductImages(tx, { id: tenantA.id }, "owner", {
        productId: productB.id,
      }),
    );
    expect(result.images).toEqual([]);
  });

  it.each<Role>(["customer", "anonymous"])(
    "refuses non-admin role=%s (defense-in-depth)",
    async (role) => {
      const tenant = await makeTenant();
      const product = await seedProduct(tenant.id);

      let threw = false;
      try {
        await withTenant(superDb, ctxFor(tenant.id), (tx) =>
          listProductImages(tx, { id: tenant.id }, role, {
            productId: product.id,
          }),
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    },
  );
});
