/**
 * `reorderProductImages` — admin product image drag-reorder
 * (chunk 1a.7.2 same-day follow-up Block 2).
 *
 * Set-replace contract: caller provides the FULL ordering of all
 * images for this product. Server validates:
 *   (a) input has no duplicates
 *   (b) input size matches the current tenant-scoped set
 *   (c) every input id exists in the current set
 *
 * All three failures collapse to wire `image_set_mismatch` (opaque);
 * the audit row's `cause.kind` differentiates `duplicate` |
 * `foreign_uuid` | `desync` for forensic correlation.
 *
 * OCC anchored on the parent product row (mirrors
 * `set-product-cover-image.ts`). Per-product advisory lock serializes
 * against upload/replace/delete/cover.
 *
 * Single SQL UPDATE with CASE expression maps id → new index inside
 * the lock window. No two-pass +1000 — there is no UNIQUE on
 * (product_id, position) so transient collisions don't violate
 * anything, and the lock makes them invisible to other readers.
 *
 * NOT destructive — no `confirm: true` required.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { products, productImages } from "@/server/db/schema/catalog";
import { StaleWriteError } from "@/server/audit/error-codes";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import { MAX_PRODUCT_IMAGE_COUNT } from "./constants";
import {
  buildReorderAuditSnapshot,
  type ReorderAuditSnapshot,
} from "./audit-snapshot";

export interface ReorderProductImagesTenantInfo {
  id: string;
}

export const ReorderProductImagesInputSchema = z
  .object({
    productId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    orderedImageIds: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_PRODUCT_IMAGE_COUNT),
  })
  .strict();

export type ReorderProductImagesInput = z.input<
  typeof ReorderProductImagesInputSchema
>;

export interface ReorderProductImagesResult {
  productId: string;
  before: ReorderAuditSnapshot;
  after: ReorderAuditSnapshot;
  productUpdatedAt: string;
}

type SetMismatchKind = "duplicate" | "foreign_uuid" | "desync";

function setMismatch(kind: SetMismatchKind): TRPCError {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: "image_set_mismatch",
    cause: { kind },
  });
}

export async function reorderProductImages(
  tx: Tx,
  tenant: ReorderProductImagesTenantInfo,
  role: Role,
  input: ReorderProductImagesInput,
): Promise<ReorderProductImagesResult> {
  if (!isWriteRole(role)) {
    throw new Error("reorderProductImages: role not permitted");
  }
  const parsed = ReorderProductImagesInputSchema.parse(input);

  // Per-product advisory lock — same key prefix as the rest of the
  // photo services so reorder serializes against upload/replace/
  // delete/cover.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('images:' || ${tenant.id} || ':' || ${parsed.productId}))`,
  );

  // OCC-anchored UPDATE on the parent product row.
  const expectedIso = parsed.expectedUpdatedAt;
  const updatedRows = await tx
    .update(products)
    .set({ updatedAt: sql`now()` })
    .where(
      and(
        eq(products.id, parsed.productId),
        eq(products.tenantId, tenant.id),
        isNull(products.deletedAt),
        sql`date_trunc('milliseconds', ${products.updatedAt}) = date_trunc('milliseconds', ${expectedIso}::timestamptz)`,
      ),
    )
    .returning({
      id: products.id,
      updatedAt: products.updatedAt,
    });

  if (updatedRows.length === 0) {
    const probe = await tx
      .select({ updatedAt: products.updatedAt })
      .from(products)
      .where(
        and(
          eq(products.id, parsed.productId),
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
    throw new StaleWriteError("reorder_product_images");
  }

  const productUpdatedAt = updatedRows[0]!.updatedAt.toISOString();

  // Read the current image-id set, tenant-scoped.
  const currentRows = await tx
    .select({
      id: productImages.id,
      position: productImages.position,
    })
    .from(productImages)
    .where(
      and(
        eq(productImages.tenantId, tenant.id),
        eq(productImages.productId, parsed.productId),
      ),
    );

  // Set-equality validation. Order matters — duplicate check first
  // since it doesn't depend on the current set; then size; then
  // foreign_uuid which scans the input.
  const inputIdSet = new Set(parsed.orderedImageIds);
  if (inputIdSet.size !== parsed.orderedImageIds.length) {
    throw setMismatch("duplicate");
  }
  const currentIdSet = new Set(currentRows.map((r) => r.id));
  if (currentIdSet.size !== inputIdSet.size) {
    throw setMismatch("desync");
  }
  for (const id of parsed.orderedImageIds) {
    if (!currentIdSet.has(id)) {
      throw setMismatch("foreign_uuid");
    }
  }

  // Build the before snapshot off the row data we already have — the
  // current ordering as captured pre-update.
  const before = buildReorderAuditSnapshot(parsed.productId, currentRows);

  // Single UPDATE with CASE expression maps id → new index. Runs
  // inside the per-product advisory lock so other readers can't see
  // a transient state.
  const caseChunks = parsed.orderedImageIds.map(
    (id, idx) => sql`WHEN ${id}::uuid THEN ${idx}::int`,
  );
  const caseBody = sql.join(caseChunks, sql` `);
  await tx
    .update(productImages)
    .set({ position: sql`CASE ${productImages.id} ${caseBody} END` })
    .where(
      and(
        eq(productImages.tenantId, tenant.id),
        eq(productImages.productId, parsed.productId),
        inArray(productImages.id, parsed.orderedImageIds),
      ),
    );

  // After snapshot — ids in input order, positions 0..N-1 by
  // construction.
  const after = buildReorderAuditSnapshot(
    parsed.productId,
    parsed.orderedImageIds.map((id, idx) => ({ id, position: idx })),
  );

  return {
    productId: parsed.productId,
    before,
    after,
    productUpdatedAt,
  };
}
