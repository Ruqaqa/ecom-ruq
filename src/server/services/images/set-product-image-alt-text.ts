/**
 * `setProductImageAltText` — set bilingual alt text on an image
 * (chunk 1a.7.1).
 *
 * Sparse partial-merge mirrors `updateProduct` description handling
 * (update-product.ts:163-173): providing only `en` preserves an
 * existing `ar` and vice versa. `null` clears the column entirely.
 *
 * OCC anchored on the parent product row — alt text is part of the
 * product's observable state (the storefront renders <img alt> from
 * it). Bumps `products.updated_at` so the next product-edit page
 * refresh sees the new OCC token.
 *
 * Audit shape carries presence flags only: `{imageId, hasEn, hasAr}`.
 * Strings never cross into the append-only chain.
 *
 * NOT destructive — does not require `confirm: true`.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { products, productImages } from "@/server/db/schema/catalog";
import { localizedTextPartial } from "@/lib/i18n/localized";
import { StaleWriteError } from "@/server/audit/error-codes";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import {
  buildAltTextAuditSnapshot,
  type AltTextAuditSnapshot,
} from "./audit-snapshot";

export interface SetProductImageAltTextTenantInfo {
  id: string;
}

export const SetProductImageAltTextInputSchema = z
  .object({
    imageId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    altText: localizedTextPartial({ max: 200 }).nullable(),
  })
  .strict();

export type SetProductImageAltTextInput = z.input<
  typeof SetProductImageAltTextInputSchema
>;

export interface SetProductImageAltTextResult {
  before: AltTextAuditSnapshot;
  after: AltTextAuditSnapshot;
  imageId: string;
  altText: { en?: string | undefined; ar?: string | undefined } | null;
}

export async function setProductImageAltText(
  tx: Tx,
  tenant: SetProductImageAltTextTenantInfo,
  role: Role,
  input: SetProductImageAltTextInput,
): Promise<SetProductImageAltTextResult> {
  if (!isWriteRole(role)) {
    throw new Error("setProductImageAltText: role not permitted");
  }
  const parsed = SetProductImageAltTextInputSchema.parse(input);

  // SELECT the image to discover productId for the lock + capture
  // pre-update altText for the audit `before` snapshot.
  const imageRows = await tx
    .select({
      id: productImages.id,
      productId: productImages.productId,
      altText: productImages.altText,
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
  const oldAltText = (imageRow.altText as
    | { en?: string | undefined; ar?: string | undefined }
    | null) ?? null;

  // Per-product advisory lock + product OCC.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('images:' || ${tenant.id} || ':' || ${productId}))`,
  );

  const expectedIso = parsed.expectedUpdatedAt;
  const updatedProductRows = await tx
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

  if (updatedProductRows.length === 0) {
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
    throw new StaleWriteError("set_product_image_alt_text");
  }

  // Compute next altText. null clears entirely; otherwise partial-
  // merge over the existing JSONB pair.
  let nextAltText:
    | { en?: string | undefined; ar?: string | undefined }
    | null;
  if (parsed.altText === null) {
    nextAltText = null;
  } else {
    nextAltText = {
      ...(oldAltText ?? {}),
      ...parsed.altText,
    };
  }

  await tx
    .update(productImages)
    .set({ altText: nextAltText, updatedAt: sql`now()` })
    .where(
      and(
        eq(productImages.id, parsed.imageId),
        eq(productImages.tenantId, tenant.id),
      ),
    );

  const auditBefore = buildAltTextAuditSnapshot({
    imageId: imageRow.id,
    altText: oldAltText,
  });
  const auditAfter = buildAltTextAuditSnapshot({
    imageId: imageRow.id,
    altText: nextAltText,
  });

  return {
    before: auditBefore,
    after: auditAfter,
    imageId: imageRow.id,
    altText: nextAltText,
  };
}
