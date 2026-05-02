/**
 * `setProductCoverImage` integration tests (chunk 1a.7.1 Block 4).
 */
import { describe, it, expect, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { withTenant } from "@/server/db";
import { setProductCoverImage } from "@/server/services/images/set-product-cover-image";
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

async function readPositions(productId: string): Promise<Array<{ id: string; position: number }>> {
  const rows = await superDb.execute<{ id: string; position: number }>(sql`
    SELECT id::text AS id, position FROM product_images
    WHERE product_id = ${productId} ORDER BY position
  `);
  return Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ id: string; position: number }> }).rows ?? []);
}

describe("setProductCoverImage", () => {
  it("swaps target image to position 0; old cover takes the target's old position", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const cover = await seedImage(tenant.id, product.id, 0, "0".repeat(64));
    const target = await seedImage(tenant.id, product.id, 2, "2".repeat(64));

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      setProductCoverImage(tx, { id: tenant.id }, "owner", {
        imageId: target,
        expectedUpdatedAt: product.updatedAt.toISOString(),
      }),
    );

    expect(result.newCoverImageId).toBe(target);
    expect(result.oldCoverImageId).toBe(cover);

    const rows = await readPositions(product.id);
    const byId = new Map(rows.map((r) => [r.id, r.position]));
    expect(byId.get(target)).toBe(0);
    expect(byId.get(cover)).toBe(2);
  });

  it("is a no-op when target image is already cover", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const cover = await seedImage(tenant.id, product.id, 0, "0".repeat(64));

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      setProductCoverImage(tx, { id: tenant.id }, "owner", {
        imageId: cover,
        expectedUpdatedAt: product.updatedAt.toISOString(),
      }),
    );

    expect(result.newCoverImageId).toBe(cover);
    expect(result.oldCoverImageId).toBe(cover);
    expect(result.before.oldCoverOldPosition).toBe(0);
    expect(result.after.newCoverOldPosition).toBe(0);
  });

  it("throws NOT_FOUND image_not_found for a missing imageId", async () => {
    const tenant = await makeTenant();

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        setProductCoverImage(tx, { id: tenant.id }, "owner", {
          imageId: "00000000-0000-4000-8000-000000000000",
          expectedUpdatedAt: new Date().toISOString(),
        }),
      );
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("NOT_FOUND");
    expect(caught!.message).toBe("image_not_found");
  });
});
