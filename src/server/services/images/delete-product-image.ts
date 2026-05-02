/**
 * `deleteProductImage` — admin product image hard-delete (chunk 1a.7.1).
 *
 * Destructive; requires `confirm: true` (CLAUDE.md §6).
 *
 * Cascade-shift inside the same lock window: deleting an image at
 * position N shifts every position > N down by 1. The lock makes the
 * transient "two rows at same position mid-shift" window invisible to
 * other callers — readers serialize against the same advisory key.
 *
 * Variant cover cleanup is automatic via the
 * `product_variants.cover_image_id` FK (ON DELETE SET NULL with the
 * column-list syntax — only cover_image_id is nulled, tenant_id stays
 * pinned).
 *
 * Storage cleanup is best-effort AFTER the tx commits. Idempotent
 * delete() means a partial failure leaves orphan files but no row;
 * Sentry-captured for follow-up GC.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { products, productImages } from "@/server/db/schema/catalog";
import { StaleWriteError } from "@/server/audit/error-codes";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import {
  getStorageAdapter,
  type StorageAdapter,
} from "@/server/storage";
import { captureMessage, summarizeErrorForObs } from "@/server/obs/sentry";
import {
  buildImageAuditSnapshot,
  type ImageAuditSnapshot,
} from "./audit-snapshot";
import type { ImageDerivative } from "@/server/db/schema/_types";

export interface DeleteProductImageTenantInfo {
  id: string;
}

export const DeleteProductImageInputSchema = z
  .object({
    imageId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    confirm: z.literal(true),
  })
  .strict();

export type DeleteProductImageInput = z.input<
  typeof DeleteProductImageInputSchema
>;

export interface DeleteProductImageResult {
  before: ImageAuditSnapshot;
  after: { deletedImageId: string; productId: string };
  /** Wire-side echo for the route handler / tRPC envelope. */
  deletedImageId: string;
  productId: string;
}

export async function deleteProductImage(
  tx: Tx,
  tenant: DeleteProductImageTenantInfo,
  role: Role,
  input: DeleteProductImageInput,
  adapter: StorageAdapter = getStorageAdapter(),
): Promise<DeleteProductImageResult> {
  if (!isWriteRole(role)) {
    throw new Error("deleteProductImage: role not permitted");
  }
  const parsed = DeleteProductImageInputSchema.parse(input);

  // SELECT the image first (for productId — needed for the lock).
  const imageRows = await tx
    .select({
      id: productImages.id,
      productId: productImages.productId,
      position: productImages.position,
      version: productImages.version,
      fingerprintSha256: productImages.fingerprintSha256,
      storageKey: productImages.storageKey,
      originalFormat: productImages.originalFormat,
      derivatives: productImages.derivatives,
    })
    .from(productImages)
    .where(
      and(
        eq(productImages.id, parsed.imageId),
        eq(productImages.tenantId, tenant.id),
      ),
    )
    .limit(1);
  if (imageRows.length === 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: "image_not_found" });
  }
  const imageRow = imageRows[0]!;
  const productId = imageRow.productId;

  // Per-product advisory lock.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('images:' || ${tenant.id} || ':' || ${productId}))`,
  );

  // OCC-anchored UPDATE on the product row.
  const expectedIso = parsed.expectedUpdatedAt;
  const updatedRows = await tx
    .update(products)
    .set({ updatedAt: sql`now()` })
    .where(
      and(
        eq(products.id, productId),
        eq(products.tenantId, tenant.id),
        isNull(products.deletedAt),
        sql`date_trunc('milliseconds', ${products.updatedAt}) = date_trunc('milliseconds', ${expectedIso}::timestamptz)`,
      ),
    )
    .returning({ id: products.id });

  if (updatedRows.length === 0) {
    const probe = await tx
      .select({ updatedAt: products.updatedAt })
      .from(products)
      .where(
        and(
          eq(products.id, productId),
          eq(products.tenantId, tenant.id),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);
    if (probe.length === 0) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "product_not_found",
      });
    }
    throw new StaleWriteError("delete_product_image");
  }

  // Capture all keys for post-tx cleanup.
  const allKeys = [
    imageRow.storageKey,
    ...(imageRow.derivatives as ImageDerivative[]).map((d) => d.storageKey),
  ];

  // DELETE the row.
  await tx
    .delete(productImages)
    .where(
      and(
        eq(productImages.id, parsed.imageId),
        eq(productImages.tenantId, tenant.id),
      ),
    );

  // Position-shift cascade inside the lock window.
  await tx
    .update(productImages)
    .set({ position: sql`${productImages.position} - 1` })
    .where(
      and(
        eq(productImages.tenantId, tenant.id),
        eq(productImages.productId, productId),
        gt(productImages.position, imageRow.position),
      ),
    );

  // Best-effort storage cleanup. Idempotent delete; failures
  // Sentry-captured but do not throw — the row is gone, the wire
  // shape is success. Fire-and-forget so the request doesn't pay
  // 16 round-trips of latency. Outer .catch only protects against
  // captureMessage itself failing.
  //
  // No tenant/product/image IDs in the capture — `scrubObsOptions`
  // strips identifier-shaped keys (`tenant_id`, `product_id`, etc.)
  // anyway, and the keys themselves derive from tenant slug + product
  // slug. Mirrors Block 7's `product_purge_storage_orphan` shape:
  // operation name + counts + sample cause is enough signal for the
  // operator to investigate via correlation_id ↔ audit_log.
  Promise.allSettled(allKeys.map((k) => adapter.delete(k)))
    .then((results) => {
      const failed = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (failed.length > 0) {
        captureMessage("image_delete_storage_orphan", {
          level: "warning",
          extra: {
            orphanCount: failed.length,
            totalKeys: allKeys.length,
            sampleCause: summarizeErrorForObs(failed[0]?.reason),
          },
        });
      }
    })
    .catch(() => {});

  const auditBefore = buildImageAuditSnapshot({
    imageId: imageRow.id,
    fingerprintSha256: imageRow.fingerprintSha256,
    position: imageRow.position,
    derivatives: imageRow.derivatives as ImageDerivative[],
    originalFormat: imageRow.originalFormat,
    productId,
  });

  return {
    before: auditBefore,
    after: { deletedImageId: imageRow.id, productId },
    deletedImageId: imageRow.id,
    productId,
  };
}
