/**
 * `setProductCoverImage` — promote an image to position 0 (cover).
 * Atomic position swap with the existing cover, both updates inside
 * the per-product advisory lock.
 *
 * Same-image (target is already cover) → no-op return; the audit
 * snapshot still records "operator pressed the button" with both old
 * and new positions = 0 (architect-ratified).
 *
 * NOT destructive — does not require `confirm: true`.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { products, productImages } from "@/server/db/schema/catalog";
import { StaleWriteError } from "@/server/audit/error-codes";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import {
  buildCoverSwapAuditSnapshot,
  type CoverSwapAuditSnapshot,
} from "./audit-snapshot";

export interface SetProductCoverImageTenantInfo {
  id: string;
}

export const SetProductCoverImageInputSchema = z
  .object({
    imageId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
  })
  .strict();

export type SetProductCoverImageInput = z.input<
  typeof SetProductCoverImageInputSchema
>;

export interface SetProductCoverImageResult {
  before: CoverSwapAuditSnapshot;
  after: CoverSwapAuditSnapshot;
  productId: string;
  oldCoverImageId: string;
  newCoverImageId: string;
}

export async function setProductCoverImage(
  tx: Tx,
  tenant: SetProductCoverImageTenantInfo,
  role: Role,
  input: SetProductCoverImageInput,
): Promise<SetProductCoverImageResult> {
  if (!isWriteRole(role)) {
    throw new Error("setProductCoverImage: role not permitted");
  }
  const parsed = SetProductCoverImageInputSchema.parse(input);

  // SELECT the target image to discover productId for the lock.
  const targetRows = await tx
    .select({
      id: productImages.id,
      productId: productImages.productId,
      position: productImages.position,
    })
    .from(productImages)
    .where(
      and(
        eq(productImages.id, parsed.imageId),
        eq(productImages.tenantId, tenant.id),
      ),
    )
    .limit(1);
  if (targetRows.length === 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: "image_not_found" });
  }
  const target = targetRows[0]!;
  const productId = target.productId;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('images:' || ${tenant.id} || ':' || ${productId}))`,
  );

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
    throw new StaleWriteError("set_product_cover_image");
  }

  // Fetch the existing cover (position 0) on the same product.
  const coverRows = await tx
    .select({ id: productImages.id, position: productImages.position })
    .from(productImages)
    .where(
      and(
        eq(productImages.tenantId, tenant.id),
        eq(productImages.productId, productId),
        eq(productImages.position, 0),
      ),
    )
    .limit(1);
  const oldCover = coverRows[0];

  // No-op early return: target is already cover.
  if (target.position === 0 && oldCover && oldCover.id === target.id) {
    const auditShape = buildCoverSwapAuditSnapshot({
      productId,
      oldCoverImageId: target.id,
      newCoverImageId: target.id,
      oldCoverOldPosition: 0,
      newCoverOldPosition: 0,
    });
    return {
      before: auditShape,
      after: auditShape,
      productId,
      oldCoverImageId: target.id,
      newCoverImageId: target.id,
    };
  }

  // Two-step swap inside the lock. The per-product advisory lock makes
  // the transient position-collision window invisible to other
  // callers. We can't violate a UNIQUE because position has no
  // uniqueness constraint — the brief explicitly leaves it
  // non-unique to support the cascade-shift in deleteProductImage.
  const oldCoverPosition = oldCover?.position ?? 0;
  const oldCoverId = oldCover?.id;

  // Two-step move: park the target out of the way, move the old cover,
  // then place the target at 0. Avoids any same-position transient
  // even though no UNIQUE constraint exists.
  const PARK = -1;
  await tx
    .update(productImages)
    .set({ position: PARK })
    .where(
      and(
        eq(productImages.id, target.id),
        eq(productImages.tenantId, tenant.id),
      ),
    );
  if (oldCoverId && oldCoverId !== target.id) {
    await tx
      .update(productImages)
      .set({ position: target.position })
      .where(
        and(
          eq(productImages.id, oldCoverId),
          eq(productImages.tenantId, tenant.id),
        ),
      );
  }
  await tx
    .update(productImages)
    .set({ position: 0 })
    .where(
      and(
        eq(productImages.id, target.id),
        eq(productImages.tenantId, tenant.id),
      ),
    );

  const audit = buildCoverSwapAuditSnapshot({
    productId,
    oldCoverImageId: oldCoverId ?? target.id,
    newCoverImageId: target.id,
    oldCoverOldPosition: oldCoverPosition,
    newCoverOldPosition: target.position,
  });

  return {
    before: audit,
    after: audit,
    productId,
    oldCoverImageId: oldCoverId ?? target.id,
    newCoverImageId: target.id,
  };
}
