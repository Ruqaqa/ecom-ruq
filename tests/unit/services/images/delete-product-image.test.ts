/**
 * `deleteProductImage` integration tests (chunk 1a.7.1 Block 4).
 *
 * Covers happy path + cascade-shift + closed-set failure modes +
 * confirm gate.
 */
import { describe, it, expect, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { withTenant } from "@/server/db";
import { deleteProductImage } from "@/server/services/images/delete-product-image";
import { StaleWriteError } from "@/server/audit/error-codes";
import { __setSentryForTests } from "@/server/obs/sentry";
import {
  ctxFor,
  inMemoryAdapter,
  makeTenant,
  seedProduct,
  superClient,
  superDb,
} from "./_helpers";

afterAll(async () => {
  await superClient.end({ timeout: 5 });
  __setSentryForTests(null);
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
      original_bytes, derivatives
    ) VALUES (
      ${tenantId}, ${productId}, ${position}, 1, ${fingerprint},
      ${`k-orig-${position}`}, 'jpeg', 1500, 1500, 1234,
      ${sql.raw(`'${JSON.stringify([
        { size: "thumb", format: "jpeg", width: 200, height: 200, storageKey: `k-thumb-${position}`, bytes: 100 },
      ])}'::jsonb`)}
    )
    RETURNING id::text AS id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ id: string }> }).rows ?? []);
  return arr[0]!.id;
}

async function getProductUpdatedAt(productId: string): Promise<string> {
  const rows = await superDb.execute<{ updated_at: string }>(sql`
    SELECT updated_at::text AS updated_at FROM products WHERE id = ${productId}
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ updated_at: string }> }).rows ?? []);
  return new Date(arr[0]!.updated_at).toISOString();
}

describe("deleteProductImage", () => {
  it("hard-deletes the row and queues all storage keys for cleanup", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    const imageId = await seedImage(tenant.id, product.id, 0, "0".repeat(64));

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      deleteProductImage(
        tx,
        { id: tenant.id },
        "owner",
        {
          imageId,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          confirm: true,
        },
        adapter,
      ),
    );

    expect(result.deletedImageId).toBe(imageId);
    expect(result.before.imageId).toBe(imageId);
    expect(result.after.deletedImageId).toBe(imageId);
    // Storage cleanup is fired (best-effort, not awaited inside the
    // service); flush microtasks so the async iteration runs.
    await new Promise((r) => setTimeout(r, 50));
    expect(adapter.deletes).toContain("k-orig-0");
    expect(adapter.deletes).toContain("k-thumb-0");

    // Row is gone from the DB.
    const remaining = await superDb.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM product_images WHERE id = ${imageId}
    `);
    const arr = Array.isArray(remaining)
      ? remaining
      : ((remaining as { rows?: Array<{ count: number }> }).rows ?? []);
    expect(arr[0]!.count).toBe(0);
  });

  it("cascade-shifts positions of remaining images", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    await seedImage(tenant.id, product.id, 0, "0".repeat(64));
    const middleId = await seedImage(tenant.id, product.id, 1, "1".repeat(64));
    await seedImage(tenant.id, product.id, 2, "2".repeat(64));
    await seedImage(tenant.id, product.id, 3, "3".repeat(64));

    await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      deleteProductImage(
        tx,
        { id: tenant.id },
        "owner",
        {
          imageId: middleId,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          confirm: true,
        },
        adapter,
      ),
    );

    // Positions reshuffle: 0 stays, 2 and 3 shift down to 1 and 2.
    const rows = await superDb.execute<{ position: number }>(sql`
      SELECT position FROM product_images WHERE product_id = ${product.id} ORDER BY position
    `);
    const arr = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: Array<{ position: number }> }).rows ?? []);
    expect(arr.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it("throws NOT_FOUND image_not_found for a missing imageId", async () => {
    const tenant = await makeTenant();
    const adapter = inMemoryAdapter();

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        deleteProductImage(
          tx,
          { id: tenant.id },
          "owner",
          {
            imageId: "00000000-0000-4000-8000-000000000000",
            expectedUpdatedAt: new Date().toISOString(),
            confirm: true,
          },
          adapter,
        ),
      );
    } catch (e) {
      caught = e as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught!.code).toBe("NOT_FOUND");
    expect(caught!.message).toBe("image_not_found");
  });

  it("throws StaleWriteError when product OCC mismatches", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const imageId = await seedImage(tenant.id, product.id, 0, "0".repeat(64));
    const adapter = inMemoryAdapter();

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        deleteProductImage(
          tx,
          { id: tenant.id },
          "owner",
          {
            imageId,
            expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
            confirm: true,
          },
          adapter,
        ),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StaleWriteError);
  });

  it("rejects a Zod-invalid input missing confirm:true at the schema layer", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const imageId = await seedImage(tenant.id, product.id, 0, "0".repeat(64));
    const adapter = inMemoryAdapter();
    const productUpdatedAt = await getProductUpdatedAt(product.id);

    let threw = false;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        deleteProductImage(
          tx,
          { id: tenant.id },
          "owner",
          // @ts-expect-error — missing `confirm: true` is rejected by Zod.
          {
            imageId,
            expectedUpdatedAt: productUpdatedAt,
          },
          adapter,
        ),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("captures `image_delete_storage_orphan` to Sentry when storage cleanup fails", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const imageId = await seedImage(tenant.id, product.id, 0, "f".repeat(64));

    // Adapter that fails every delete() call.
    const failingAdapter = {
      put: async () => {},
      get: async () => null,
      delete: async () => {
        throw new Error("simulated storage outage");
      },
    } as const;

    // Spy on the Sentry shim.
    const captured: Array<{ name: string; options: unknown }> = [];
    __setSentryForTests({
      captureMessage(name, options) {
        captured.push({ name, options });
      },
    });

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      deleteProductImage(
        tx,
        { id: tenant.id },
        "owner",
        {
          imageId,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          confirm: true,
        },
        failingAdapter,
      ),
    );

    // (a) Wire shape is success — caller doesn't see the storage outage.
    expect(result.deletedImageId).toBe(imageId);

    // (b) Row is gone from the DB inside the same tx.
    const remaining = await superDb.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM product_images WHERE id = ${imageId}
    `);
    const arr = Array.isArray(remaining)
      ? remaining
      : (remaining as { rows?: Array<{ count: number }> }).rows ?? [];
    expect(arr[0]!.count).toBe(0);

    // (c) Sentry capture fired (post-tx, fire-and-forget). Identifier
    // tags are deliberately absent — `scrubObsOptions` would strip
    // them, and Block 7's `product_purge_storage_orphan` follows the
    // same shape (operation name + counts + sample cause).
    await new Promise((r) => setTimeout(r, 100));
    const orphan = captured.find(
      (c) => c.name === "image_delete_storage_orphan",
    );
    expect(orphan).toBeDefined();
    const opts = orphan!.options as {
      level: string;
      extra: { orphanCount: number; totalKeys: number; sampleCause: string };
    };
    expect(opts.level).toBe("warning");
    expect(opts.extra.orphanCount).toBeGreaterThan(0);
    expect(opts.extra.orphanCount).toBe(opts.extra.totalKeys);
    expect(typeof opts.extra.sampleCause).toBe("string");

    __setSentryForTests(null);
  });
});
