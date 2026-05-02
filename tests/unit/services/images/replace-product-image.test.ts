/**
 * `replaceProductImage` integration tests (chunk 1a.7.1 Block 4).
 *
 * Versioned-key replace: bumps version, uploads NEW keys, schedules
 * old-key cleanup post-tx.
 */
import { describe, it, expect, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { withTenant } from "@/server/db";
import { replaceProductImage } from "@/server/services/images/replace-product-image";
import { uploadProductImage } from "@/server/services/images/upload-product-image";
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
import { makeJpeg } from "./_fixtures";

afterAll(async () => {
  await superClient.end({ timeout: 5 });
  __setSentryForTests(null);
});

async function getProductUpdatedAt(productId: string): Promise<string> {
  const rows = await superDb.execute<{ updated_at: string }>(sql`
    SELECT updated_at::text AS updated_at FROM products WHERE id = ${productId}
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ updated_at: string }> }).rows ?? []);
  return new Date(arr[0]!.updated_at).toISOString();
}

describe("replaceProductImage", () => {
  it("bumps version and uploads new keys with v2 prefix", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    const jpegA = await makeJpeg(1500, 1500);

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
    const oldKey = r1.image.storageKey;
    const oldDerivKeys = r1.image.derivatives.map((d) => d.storageKey);

    // Different bytes ⇒ different fingerprint, no duplicate-collision.
    const jpegB = await makeJpeg(1400, 1400);
    const productUpdated = await getProductUpdatedAt(product.id);

    const r2 = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      replaceProductImage(
        tx,
        { id: tenant.id },
        "owner",
        {
          imageId: r1.image.id,
          expectedUpdatedAt: productUpdated,
          bytes: jpegB.toString("base64"),
          confirm: true,
        },
        adapter,
      ),
    );

    expect(r2.image.id).toBe(r1.image.id);
    expect(r2.image.version).toBe(2);
    expect(r2.image.storageKey).toMatch(/-v2-original\.jpg$/);
    expect(r2.image.fingerprintSha256).not.toBe(r1.image.fingerprintSha256);
    expect(r2.before.fingerprintSha256).toBe(r1.image.fingerprintSha256);
    expect(r2.after.fingerprintSha256).toBe(r2.image.fingerprintSha256);

    // Storage cleanup is fired post-update; flush microtasks.
    await new Promise((r) => setTimeout(r, 50));
    expect(adapter.deletes).toContain(oldKey);
    for (const k of oldDerivKeys) {
      expect(adapter.deletes).toContain(k);
    }
  });

  it("throws NOT_FOUND image_not_found for a missing imageId", async () => {
    const tenant = await makeTenant();
    const adapter = inMemoryAdapter();
    const jpeg = await makeJpeg(1500, 1500);

    let caught: TRPCError | null = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        replaceProductImage(
          tx,
          { id: tenant.id },
          "owner",
          {
            imageId: "00000000-0000-4000-8000-000000000000",
            expectedUpdatedAt: new Date().toISOString(),
            bytes: jpeg.toString("base64"),
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

  it("rejects without confirm:true (Zod schema gate)", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    const jpegA = await makeJpeg(1500, 1500);
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
    const productUpdated = await getProductUpdatedAt(product.id);

    let threw = false;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        replaceProductImage(
          tx,
          { id: tenant.id },
          "owner",
          // @ts-expect-error — missing confirm:true.
          {
            imageId: r1.image.id,
            expectedUpdatedAt: productUpdated,
            bytes: jpegA.toString("base64"),
          },
          adapter,
        ),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("throws StaleWriteError on product OCC mismatch", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();
    const jpegA = await makeJpeg(1500, 1500);
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
    const jpegB = await makeJpeg(1400, 1400);

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        replaceProductImage(
          tx,
          { id: tenant.id },
          "owner",
          {
            imageId: r1.image.id,
            expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
            bytes: jpegB.toString("base64"),
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

  it("captures `image_replace_storage_orphan` to Sentry when old-key cleanup fails", async () => {
    const tenant = await makeTenant();
    const product = await seedProduct(tenant.id);
    const adapter = inMemoryAdapter();

    // Initial upload to create v1.
    const jpegA = await makeJpeg(1500, 1500);
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

    // Replace with a flaky old-key delete: put() succeeds for v2, but
    // delete() (used for old-key cleanup) throws.
    const flakyAdapter = {
      async put(key: string, bytes: Buffer, contentType: string) {
        // Delegate puts to the working adapter so v2 actually lands.
        return adapter.put(key, bytes, contentType);
      },
      async get(): Promise<{ bytes: Buffer; contentType: string } | null> {
        return null;
      },
      async delete(): Promise<void> {
        throw new Error("simulated old-key delete outage");
      },
    };

    const captured: Array<{ name: string; options: unknown }> = [];
    __setSentryForTests({
      captureMessage(name, options) {
        captured.push({ name, options });
      },
    });

    const productUpdated = await getProductUpdatedAt(product.id);
    const jpegB = await makeJpeg(1400, 1400);
    const r2 = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      replaceProductImage(
        tx,
        { id: tenant.id },
        "owner",
        {
          imageId: r1.image.id,
          expectedUpdatedAt: productUpdated,
          bytes: jpegB.toString("base64"),
          confirm: true,
        },
        flakyAdapter,
      ),
    );

    // Wire shape is success; v2 row landed.
    expect(r2.image.version).toBe(2);

    // Sentry capture fires (post-tx, fire-and-forget).
    await new Promise((r) => setTimeout(r, 100));
    const orphan = captured.find(
      (c) => c.name === "image_replace_storage_orphan",
    );
    expect(orphan).toBeDefined();
    const opts = orphan!.options as {
      level: string;
      extra: { orphanCount: number; totalKeys: number };
    };
    expect(opts.level).toBe("warning");
    expect(opts.extra.orphanCount).toBe(opts.extra.totalKeys);

    __setSentryForTests(null);
  });
});
