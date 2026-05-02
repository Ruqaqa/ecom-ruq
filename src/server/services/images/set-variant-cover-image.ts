/**
 * `setVariantCoverImage` — set or clear a variant's cover image.
 * Cover image must belong to the same product as the variant.
 *
 * `imageId: null` clears the cover (variant falls back to product
 * cover).
 *
 * OCC anchored on the variant row (variant-row mutation; product
 * `updated_at` is not bumped — the product itself didn't change,
 * only the variant did). Composite same-tenant FK from migration
 * 0012 enforces same-tenant at the data layer; same-product check
 * is app-layer (no FK for it).
 *
 * NOT destructive — does not require `confirm: true`.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import {
  productImages,
  productVariants,
} from "@/server/db/schema/catalog";
import { StaleWriteError } from "@/server/audit/error-codes";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import {
  buildVariantCoverAuditSnapshot,
  type VariantCoverAuditSnapshot,
} from "./audit-snapshot";

export interface SetVariantCoverImageTenantInfo {
  id: string;
}

export const SetVariantCoverImageInputSchema = z
  .object({
    variantId: z.string().uuid(),
    imageId: z.string().uuid().nullable(),
    expectedUpdatedAt: z.string().datetime(),
  })
  .strict();

export type SetVariantCoverImageInput = z.input<
  typeof SetVariantCoverImageInputSchema
>;

export interface SetVariantCoverImageResult {
  before: VariantCoverAuditSnapshot;
  after: VariantCoverAuditSnapshot;
  variantId: string;
  oldCoverImageId: string | null;
  newCoverImageId: string | null;
}

export async function setVariantCoverImage(
  tx: Tx,
  tenant: SetVariantCoverImageTenantInfo,
  role: Role,
  input: SetVariantCoverImageInput,
): Promise<SetVariantCoverImageResult> {
  if (!isWriteRole(role)) {
    throw new Error("setVariantCoverImage: role not permitted");
  }
  const parsed = SetVariantCoverImageInputSchema.parse(input);

  // SELECT the variant. Captures productId for the same-product check
  // and current cover_image_id for the audit `before` shape.
  const variantRows = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      coverImageId: productVariants.coverImageId,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.id, parsed.variantId),
        eq(productVariants.tenantId, tenant.id),
      ),
    )
    .limit(1);
  if (variantRows.length === 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: "variant_not_found" });
  }
  const variant = variantRows[0]!;

  // If a non-null cover is being set, validate it exists, belongs to
  // the same tenant, and is on the same product.
  if (parsed.imageId !== null) {
    const imageRows = await tx
      .select({
        id: productImages.id,
        productId: productImages.productId,
      })
      .from(productImages)
      .where(
        and(
          eq(productImages.id, parsed.imageId),
          eq(productImages.tenantId, tenant.id),
        ),
      )
      .limit(1);
    if (imageRows.length === 0 || imageRows[0]!.productId !== variant.productId) {
      // Same opaque NOT_FOUND for "image not found" and "image belongs
      // to a different product" — no existence-leak channel for
      // cross-product image-id probes.
      throw new TRPCError({ code: "NOT_FOUND", message: "image_not_found" });
    }
  }

  // OCC-anchored UPDATE on the variant row. Variant `updated_at` is
  // the OCC token; we don't bump products.updated_at because this is
  // a variant-row mutation only.
  const expectedIso = parsed.expectedUpdatedAt;
  const updatedRows = await tx
    .update(productVariants)
    .set({ coverImageId: parsed.imageId, updatedAt: sql`now()` })
    .where(
      and(
        eq(productVariants.id, parsed.variantId),
        eq(productVariants.tenantId, tenant.id),
        sql`date_trunc('milliseconds', ${productVariants.updatedAt}) = date_trunc('milliseconds', ${expectedIso}::timestamptz)`,
      ),
    )
    .returning({ id: productVariants.id });

  if (updatedRows.length === 0) {
    // The variant row exists (we read it above), so this must be OCC.
    throw new StaleWriteError("set_variant_cover_image");
  }

  const auditBefore = buildVariantCoverAuditSnapshot({
    variantId: variant.id,
    oldCoverImageId: variant.coverImageId ?? null,
    newCoverImageId: parsed.imageId,
  });
  const auditAfter = auditBefore;

  return {
    before: auditBefore,
    after: auditAfter,
    variantId: variant.id,
    oldCoverImageId: variant.coverImageId ?? null,
    newCoverImageId: parsed.imageId,
  };
}
