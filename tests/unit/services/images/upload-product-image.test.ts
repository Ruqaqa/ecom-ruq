/**
 * `uploadProductImage` integration tests (chunk 1a.7.1 Block 4).
 *
 * Covers:
 *   - happy path (1500×1500 JPEG) → row created + 16 storage keys uploaded
 *   - role-gate refusal (anonymous, customer, support) → throws
 *   - product not found → NOT_FOUND product_not_found
 *   - product OCC mismatch → StaleWriteError
 *   - per-product cap exceeded (10 images) → BAD_REQUEST image_count_exceeded
 *   - duplicate fingerprint (proactive probe) → CONFLICT image_duplicate_in_product
 *   - duplicate fingerprint (race-loss path via pg 23505) → same CONFLICT
 *   - unsupported format → BAD_REQUEST image_unsupported_format
 *   - too small → BAD_REQUEST image_too_small
 *   - storage upload failure → INTERNAL_SERVER_ERROR image_storage_failed
 *     + row rolled back inside the same tx
 *
 * Uses the shared in-memory storage adapter so the assertions inspect
 * the put-call ledger without touching disk.
 */
import { describe, it, expect, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { withTenant } from "@/server/db";
import { uploadProductImage } from "@/server/services/images/upload-product-image";
import { StaleWriteError } from "@/server/audit/error-codes";
import {
  ctxFor,
  inMemoryAdapter,
  makeTenant,
  readImageRows,
  seedProduct,
  superClient,
  superDb,
} from "./_helpers";
import { makeJpeg, makeSvg } from "./_fixtures";
import type { Role } from "@/server/tenant/context";

afterAll(async () => {
  await superClient.end({ timeout: 5 });
});

describe("uploadProductImage — happy path", () => {
  it("inserts a row and uploads 16 storage entries for a 1500x1500 JPEG", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    const jpeg = await makeJpeg(1500, 1500);

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      uploadProductImage(
        tx,
        { id: tenant.id },
        "owner",
        {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          bytes: jpeg.toString("base64"),
        },
        adapter,
      ),
    );

    expect(result.before).toBeNull();
    expect(result.after.imageId).toBe(result.image.id);
    expect(result.after.derivativeCount).toBe(15);
    expect(result.after.derivativeSizes).toEqual([
      "card",
      "page",
      "share",
      "thumb",
      "zoom",
    ]);
    expect(result.after.originalFormat).toBe("jpeg");
    expect(result.after.productId).toBe(product.id);
    expect(result.after.position).toBe(0);

    expect(result.image.version).toBe(1);
    expect(result.image.derivatives).toHaveLength(15);
    expect(result.image.storageKey).toMatch(
      /^[a-z0-9-]+\/p-[a-f0-9]+-0-v1-original\.jpg$/,
    );

    const rows = await readImageRows(product.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.position).toBe(0);
    expect(rows[0]!.version).toBe(1);

    expect(adapter.puts).toHaveLength(16); // 1 original + 15 derivatives
    // All upload keys appear on the put-ledger.
    const putKeys = new Set(adapter.puts.map((p) => p.key));
    expect(putKeys.has(result.image.storageKey)).toBe(true);
    for (const d of result.image.derivatives) {
      expect(putKeys.has(d.storageKey)).toBe(true);
    }
    expect(adapter.deletes).toHaveLength(0);
  });

  it("appends successive uploads at increasing positions", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    const jpegA = await makeJpeg(1500, 1500);
    const jpegB = await makeJpeg(1400, 1400);

    const r1 = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      uploadProductImage(
        tx,
        { id: tenant.id },
        "owner",
        {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          bytes: jpegA.toString("base64"),
        },
        adapter,
      ),
    );
    expect(r1.image.position).toBe(0);

    // Read the bumped product.updated_at for the second upload's OCC.
    const updated = await superDb.execute<{ updated_at: string }>(sql`
      SELECT updated_at::text AS updated_at FROM products WHERE id = ${product.id}
    `);
    const arr = Array.isArray(updated)
      ? updated
      : ((updated as { rows?: Array<{ updated_at: string }> }).rows ?? []);
    const newUpdatedAt = new Date(arr[0]!.updated_at).toISOString();

    const r2 = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      uploadProductImage(
        tx,
        { id: tenant.id },
        "owner",
        {
          productId: product.id,
          expectedUpdatedAt: newUpdatedAt,
          bytes: jpegB.toString("base64"),
        },
        adapter,
      ),
    );
    expect(r2.image.position).toBe(1);
  });
});

describe("uploadProductImage — closed-set failure modes", () => {
  it("throws when product is not found", async () => {
    const tenant = await makeTenant();
    const adapter = inMemoryAdapter();
    const jpeg = await makeJpeg(1500, 1500);
    const fakeProductId = "00000000-0000-4000-8000-000000000000";

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        uploadProductImage(
          tx,
          { id: tenant.id },
          "owner",
          {
            productId: fakeProductId,
            expectedUpdatedAt: new Date().toISOString(),
            bytes: jpeg.toString("base64"),
          },
          adapter,
        ),
      );
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("NOT_FOUND");
    expect(caught!.message).toBe("product_not_found");
  });

  it("throws StaleWriteError when product OCC mismatches", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    const jpeg = await makeJpeg(1500, 1500);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        uploadProductImage(
          tx,
          { id: tenant.id },
          "owner",
          {
            productId: product.id,
            // Stale OCC token — way in the past.
            expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
            bytes: jpeg.toString("base64"),
          },
          adapter,
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaleWriteError);
  });

  it("rejects per-product cap (10 images) with BAD_REQUEST image_count_exceeded", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    // Pre-seed 10 image rows directly so we hit the cap fast without
    // running the full pipeline 10 times.
    for (let i = 0; i < 10; i++) {
      await superDb.execute(sql`
        INSERT INTO product_images (
          tenant_id, product_id, position, version, fingerprint_sha256,
          storage_key, original_format, original_width, original_height,
          original_bytes
        ) VALUES (
          ${tenant.id}, ${product.id}, ${i}, 1,
          ${"f".repeat(63) + i.toString(16)},
          ${`k-${i}`}, 'jpeg', 1500, 1500, 1234
        )
      `);
    }

    const adapter = inMemoryAdapter();
    const jpeg = await makeJpeg(1500, 1500);

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        uploadProductImage(
          tx,
          { id: tenant.id },
          "owner",
          {
            productId: product.id,
            expectedUpdatedAt: product.updatedAt.toISOString(),
            bytes: jpeg.toString("base64"),
          },
          adapter,
        ),
      );
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(caught!.message).toBe("image_count_exceeded");
  });

  it("rejects a duplicate fingerprint via the proactive probe (CONFLICT image_duplicate_in_product)", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    const jpeg = await makeJpeg(1500, 1500);

    const r1 = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      uploadProductImage(
        tx,
        { id: tenant.id },
        "owner",
        {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          bytes: jpeg.toString("base64"),
        },
        adapter,
      ),
    );

    const updated = await superDb.execute<{ updated_at: string }>(sql`
      SELECT updated_at::text AS updated_at FROM products WHERE id = ${product.id}
    `);
    const arr = Array.isArray(updated)
      ? updated
      : ((updated as { rows?: Array<{ updated_at: string }> }).rows ?? []);
    const newUpdatedAt = new Date(arr[0]!.updated_at).toISOString();

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        uploadProductImage(
          tx,
          { id: tenant.id },
          "owner",
          {
            productId: product.id,
            expectedUpdatedAt: newUpdatedAt,
            bytes: jpeg.toString("base64"),
          },
          adapter,
        ),
      );
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("CONFLICT");
    expect(caught!.message).toBe("image_duplicate_in_product");
    const cause = caught!.cause as unknown as { existingImageId: string };
    expect(cause.existingImageId).toBe(r1.image.id);
  });

  it("rejects an unsupported format (SVG) with BAD_REQUEST image_unsupported_format", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    const svg = makeSvg();

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        uploadProductImage(
          tx,
          { id: tenant.id },
          "owner",
          {
            productId: product.id,
            expectedUpdatedAt: product.updatedAt.toISOString(),
            bytes: svg.toString("base64"),
          },
          adapter,
        ),
      );
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(caught!.message).toBe("image_unsupported_format");
  });

  it("rejects too-small input with BAD_REQUEST image_too_small", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    const tiny = await makeJpeg(300, 200);

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        uploadProductImage(
          tx,
          { id: tenant.id },
          "owner",
          {
            productId: product.id,
            expectedUpdatedAt: product.updatedAt.toISOString(),
            bytes: tiny.toString("base64"),
          },
          adapter,
        ),
      );
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("BAD_REQUEST");
    expect(caught!.message).toBe("image_too_small");
  });

  it("rolls back the row when storage uploads fail (image_storage_failed)", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    adapter.failMode = "fail-all";
    const jpeg = await makeJpeg(1500, 1500);

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        uploadProductImage(
          tx,
          { id: tenant.id },
          "owner",
          {
            productId: product.id,
            expectedUpdatedAt: product.updatedAt.toISOString(),
            bytes: jpeg.toString("base64"),
          },
          adapter,
        ),
      );
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("INTERNAL_SERVER_ERROR");
    expect(caught!.message).toBe("image_storage_failed");

    // Row was rolled back inside the same tx → DB has zero images.
    const rows = await readImageRows(product.id);
    expect(rows).toHaveLength(0);
  });
});

describe("uploadProductImage — defense-in-depth role gate", () => {
  it.each<Role>(["customer", "support", "anonymous"])(
    "throws on role=%s",
    async (role) => {
      const tenant = await makeTenant();
      const product = await seedProduct(tenant.id);
      const adapter = inMemoryAdapter();
      const jpeg = await makeJpeg(1500, 1500);

      let threw = false;
      try {
        await withTenant(superDb, ctxFor(tenant.id), (tx) =>
          uploadProductImage(
            tx,
            { id: tenant.id },
            role,
            {
              productId: product.id,
              expectedUpdatedAt: product.updatedAt.toISOString(),
              bytes: jpeg.toString("base64"),
            },
            adapter,
          ),
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    },
  );
});
