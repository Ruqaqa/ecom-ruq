/**
 * `setVariantCoverImage` integration tests (chunk 1a.7.1 Block 4).
 */
import { describe, it, expect, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { withTenant } from "@/server/db";
import { setVariantCoverImage } from "@/server/services/images/set-variant-cover-image";
import { StaleWriteError } from "@/server/audit/error-codes";
import {
  ctxFor,
  makeTenant,
  seedProduct,
  seedVariant,
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
): Promise<string> {
  const rows = await superDb.execute<{ id: string }>(sql`
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
    : ((rows as { rows?: Array<{ id: string }> }).rows ?? []);
  return arr[0]!.id;
}

describe("setVariantCoverImage", () => {
  it("sets a cover image when the image is on the same product", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const variant = await seedVariant(tenant.id, product.id);
    const imageId = await seedImage(tenant.id, product.id, 0, "0".repeat(64));

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      setVariantCoverImage(tx, { id: tenant.id }, "owner", {
        variantId: variant.id,
        imageId,
        expectedUpdatedAt: variant.updatedAt.toISOString(),
      }),
    );

    expect(result.newCoverImageId).toBe(imageId);
    expect(result.oldCoverImageId).toBeNull();
  });

  it("clears the cover when imageId is null", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const variant = await seedVariant(tenant.id, product.id);
    const imageId = await seedImage(tenant.id, product.id, 0, "0".repeat(64));

    // Set first
    const r1 = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      setVariantCoverImage(tx, { id: tenant.id }, "owner", {
        variantId: variant.id,
        imageId,
        expectedUpdatedAt: variant.updatedAt.toISOString(),
      }),
    );
    void r1;

    // Read variant updated_at after first set.
    const updated = await superDb.execute<{ updated_at: string }>(sql`
      SELECT updated_at::text AS updated_at FROM product_variants WHERE id = ${variant.id}
    `);
    const arr = Array.isArray(updated)
      ? updated
      : ((updated as { rows?: Array<{ updated_at: string }> }).rows ?? []);
    const newUpdatedAt = new Date(arr[0]!.updated_at).toISOString();

    // Clear
    const r2 = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      setVariantCoverImage(tx, { id: tenant.id }, "owner", {
        variantId: variant.id,
        imageId: null,
        expectedUpdatedAt: newUpdatedAt,
      }),
    );
    expect(r2.newCoverImageId).toBeNull();
    expect(r2.oldCoverImageId).toBe(imageId);
  });

  it("rejects an image that belongs to a different product (NOT_FOUND image_not_found)", async () => {
    const tenant = await makeTenant();
    const productA = await seedProduct(tenant.id);
    const productB = await seedProduct(tenant.id);
    const variantA = await seedVariant(tenant.id, productA.id);
    const imageOnB = await seedImage(tenant.id, productB.id, 0, "b".repeat(64));

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        setVariantCoverImage(tx, { id: tenant.id }, "owner", {
          variantId: variantA.id,
          imageId: imageOnB,
          expectedUpdatedAt: variantA.updatedAt.toISOString(),
        }),
      );
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("NOT_FOUND");
    expect(caught!.message).toBe("image_not_found");
  });

  it("throws NOT_FOUND variant_not_found for a missing variantId", async () => {
    const tenant = await makeTenant();

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        setVariantCoverImage(tx, { id: tenant.id }, "owner", {
          variantId: "00000000-0000-4000-8000-000000000000",
          imageId: null,
          expectedUpdatedAt: new Date().toISOString(),
        }),
      );
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("NOT_FOUND");
    expect(caught!.message).toBe("variant_not_found");
  });

  it("throws StaleWriteError on variant OCC mismatch", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const variant = await seedVariant(tenant.id, product.id);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        setVariantCoverImage(tx, { id: tenant.id }, "owner", {
          variantId: variant.id,
          imageId: null,
          expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaleWriteError);
  });
});
