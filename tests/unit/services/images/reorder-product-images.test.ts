/**
 * `reorderProductImages` integration tests (chunk 1a.7.2 same-day
 * follow-up Block 4).
 *
 * Covers:
 *   1. Happy path — three images reordered, snapshots returned.
 *   2. Single-image no-op.
 *   3. Duplicate UUID in input → image_set_mismatch / cause.kind=duplicate.
 *   4. Foreign UUID → cause.kind=foreign_uuid.
 *   5. Length mismatch (input shorter) → cause.kind=desync.
 *   6. Stale-write → StaleWriteError; product_images NOT updated.
 *   7. Soft-deleted / not-found product → product_not_found.
 *   8. Cross-tenant isolation — RLS hides parent → product_not_found.
 *   9. Advisory lock SQL pattern matches the per-product key prefix.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { withTenant } from "@/server/db";
import { reorderProductImages } from "@/server/services/images/reorder-product-images";
import { StaleWriteError } from "@/server/audit/error-codes";
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
      original_bytes, derivatives, alt_text
    ) VALUES (
      ${tenantId}, ${productId}, ${position}, 1, ${fingerprint},
      ${`k-${position}-${fingerprint.slice(0, 4)}`}, 'jpeg', 1500, 1500, 1234,
      '[]'::jsonb, NULL
    )
    RETURNING id::text AS id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ id: string }> }).rows ?? []);
  return arr[0]!.id;
}

async function readImagePositions(
  productId: string,
): Promise<Array<{ id: string; position: number }>> {
  const rows = await superDb.execute<{ id: string; position: number }>(sql`
    SELECT id::text AS id, position
    FROM product_images
    WHERE product_id = ${productId}
    ORDER BY position, id
  `);
  const arr = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ id: string; position: number }> }).rows ??
        []);
  return arr;
}

describe("reorderProductImages", () => {
  it("happy path — three images reordered into requested order; before/after snapshots returned", async () => {
    const tenant = await makeTenant("rorder");
    const product = await seedProduct(tenant.id);
    const a = await seedImage(tenant.id, product.id, 0, "a".repeat(64));
    const b = await seedImage(tenant.id, product.id, 1, "b".repeat(64));
    const c = await seedImage(tenant.id, product.id, 2, "c".repeat(64));

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      reorderProductImages(tx, { id: tenant.id }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        orderedImageIds: [c, a, b],
      }),
    );

    expect(result.productId).toBe(product.id);
    expect(result.productUpdatedAt).toBeTypeOf("string");
    expect(() => new Date(result.productUpdatedAt).toISOString()).not.toThrow();

    // After snapshot is exactly the input order, positions 0..N-1.
    expect(result.after.kind).toBe("reorder");
    expect(result.after.ordering.map((o) => o.imageId)).toEqual([c, a, b]);
    expect(result.after.ordering.map((o) => o.position)).toEqual([0, 1, 2]);

    // Before snapshot reflects the pre-update positions.
    const beforeIds = result.before.ordering.map((o) => o.imageId);
    expect(beforeIds).toEqual([a, b, c]);

    // DB reflects the new ordering.
    const persisted = await readImagePositions(product.id);
    const positionsById = new Map(persisted.map((r) => [r.id, r.position]));
    expect(positionsById.get(c)).toBe(0);
    expect(positionsById.get(a)).toBe(1);
    expect(positionsById.get(b)).toBe(2);
  });

  it("single-image no-op: ordering of length 1 succeeds without error", async () => {
    const tenant = await makeTenant("rorder");
    const product = await seedProduct(tenant.id);
    const a = await seedImage(tenant.id, product.id, 0, "a".repeat(64));

    const result = await withTenant(superDb, ctxFor(tenant.id), (tx) =>
      reorderProductImages(tx, { id: tenant.id }, "owner", {
        productId: product.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
        orderedImageIds: [a],
      }),
    );
    expect(result.after.ordering).toEqual([{ imageId: a, position: 0 }]);
  });

  it("rejects image_set_mismatch with cause.kind=duplicate when input has duplicate uuids; no DB write", async () => {
    const tenant = await makeTenant("rorder");
    const product = await seedProduct(tenant.id);
    const a = await seedImage(tenant.id, product.id, 0, "a".repeat(64));
    const b = await seedImage(tenant.id, product.id, 1, "b".repeat(64));
    await seedImage(tenant.id, product.id, 2, "c".repeat(64));

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        reorderProductImages(tx, { id: tenant.id }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          orderedImageIds: [a, a, b],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    const trpcErr = caught as TRPCError;
    expect(trpcErr.code).toBe("BAD_REQUEST");
    expect(trpcErr.message).toBe("image_set_mismatch");
    expect((trpcErr.cause as { kind?: string })?.kind).toBe("duplicate");

    // Positions unchanged.
    const persisted = await readImagePositions(product.id);
    expect(persisted.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it("rejects image_set_mismatch with cause.kind=foreign_uuid when input contains a uuid not on this product", async () => {
    const tenant = await makeTenant("rorder");
    const product = await seedProduct(tenant.id);
    const a = await seedImage(tenant.id, product.id, 0, "a".repeat(64));
    const b = await seedImage(tenant.id, product.id, 1, "b".repeat(64));
    const c = await seedImage(tenant.id, product.id, 2, "c".repeat(64));
    const FOREIGN = randomUUID();
    void c;

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        reorderProductImages(tx, { id: tenant.id }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          orderedImageIds: [a, b, FOREIGN],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    const trpcErr = caught as TRPCError;
    expect(trpcErr.message).toBe("image_set_mismatch");
    expect((trpcErr.cause as { kind?: string })?.kind).toBe("foreign_uuid");

    const persisted = await readImagePositions(product.id);
    expect(persisted.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it("rejects image_set_mismatch with cause.kind=desync when input has fewer ids than the current set", async () => {
    const tenant = await makeTenant("rorder");
    const product = await seedProduct(tenant.id);
    const a = await seedImage(tenant.id, product.id, 0, "a".repeat(64));
    const b = await seedImage(tenant.id, product.id, 1, "b".repeat(64));
    await seedImage(tenant.id, product.id, 2, "c".repeat(64));

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        reorderProductImages(tx, { id: tenant.id }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          orderedImageIds: [a, b],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    const trpcErr = caught as TRPCError;
    expect(trpcErr.message).toBe("image_set_mismatch");
    expect((trpcErr.cause as { kind?: string })?.kind).toBe("desync");

    const persisted = await readImagePositions(product.id);
    expect(persisted.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it("throws StaleWriteError on OCC mismatch; product_images positions remain unchanged", async () => {
    const tenant = await makeTenant("rorder");
    const product = await seedProduct(tenant.id);
    const a = await seedImage(tenant.id, product.id, 0, "a".repeat(64));
    const b = await seedImage(tenant.id, product.id, 1, "b".repeat(64));
    const c = await seedImage(tenant.id, product.id, 2, "c".repeat(64));

    // Bump products.updated_at out-of-band so the OCC token is stale.
    await superDb.execute(
      sql`UPDATE products SET updated_at = updated_at + interval '1 second' WHERE id = ${product.id}`,
    );

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        reorderProductImages(tx, { id: tenant.id }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          orderedImageIds: [c, b, a],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StaleWriteError);

    // Positions unchanged.
    const persisted = await readImagePositions(product.id);
    const positionsById = new Map(persisted.map((r) => [r.id, r.position]));
    expect(positionsById.get(a)).toBe(0);
    expect(positionsById.get(b)).toBe(1);
    expect(positionsById.get(c)).toBe(2);
  });

  it("returns product_not_found when the product is soft-deleted", async () => {
    const tenant = await makeTenant("rorder");
    const product = await seedProduct(tenant.id);
    const a = await seedImage(tenant.id, product.id, 0, "a".repeat(64));
    await superDb.execute(
      sql`UPDATE products SET deleted_at = now() WHERE id = ${product.id}`,
    );

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenant.id), (tx) =>
        reorderProductImages(tx, { id: tenant.id }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          orderedImageIds: [a],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
    expect((caught as TRPCError).message).toBe("product_not_found");
  });

  it("does not leak across tenants — tenant A asks for tenant B's productId → product_not_found", async () => {
    const tenantA = await makeTenant("rorder-a");
    const tenantB = await makeTenant("rorder-b");
    const productB = await seedProduct(tenantB.id);
    const bImg = await seedImage(tenantB.id, productB.id, 0, "b".repeat(64));

    let caught: unknown = null;
    try {
      await withTenant(superDb, ctxFor(tenantA.id), (tx) =>
        reorderProductImages(tx, { id: tenantA.id }, "owner", {
          productId: productB.id,
          expectedUpdatedAt: productB.updatedAt.toISOString(),
          orderedImageIds: [bImg],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("NOT_FOUND");
    expect((caught as TRPCError).message).toBe("product_not_found");
  });

  it("acquires the per-product advisory lock with the canonical 'images:tenant:product' key", async () => {
    const tenant = await makeTenant("rorder");
    const product = await seedProduct(tenant.id);
    const a = await seedImage(tenant.id, product.id, 0, "a".repeat(64));

    // Spy `tx.execute` to capture the first invocation, which is the
    // advisory-lock acquire. Drizzle's execute is awaited internally;
    // we don't replace the implementation, just record the SQL.
    const seen: string[] = [];
    await withTenant(superDb, ctxFor(tenant.id), async (tx) => {
      const original = tx.execute.bind(tx);
      const spy = vi
        .spyOn(tx, "execute")
        .mockImplementation((arg: Parameters<typeof original>[0]) => {
          // Drizzle SQL chunks have a `getSQL()` method; fallback to
          // string-coerce.
          try {
            const s =
              typeof arg === "object" && arg !== null && "getSQL" in arg
                ? JSON.stringify((arg as { getSQL: () => unknown }).getSQL())
                : String(arg);
            seen.push(s);
          } catch {
            seen.push("<sql>");
          }
          return original(arg);
        });
      try {
        await reorderProductImages(tx, { id: tenant.id }, "owner", {
          productId: product.id,
          expectedUpdatedAt: product.updatedAt.toISOString(),
          orderedImageIds: [a],
        });
      } finally {
        spy.mockRestore();
      }
    });

    // Assert at least one captured SQL invocation references the
    // expected lock-key ingredients.
    const lockTouches = seen.filter(
      (s) =>
        /pg_advisory_xact_lock/.test(s) &&
        /images:/.test(s) &&
        s.includes(tenant.id) &&
        s.includes(product.id),
    );
    expect(lockTouches.length).toBeGreaterThanOrEqual(1);
  });
});
