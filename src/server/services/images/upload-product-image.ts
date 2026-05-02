/**
 * `uploadProductImage` — admin product image upload (chunk 1a.7.1).
 *
 * Mirrors the variants `setProductOptions` shape:
 *   1. No `withTenant` / no tx open — adapter owns the lifecycle.
 *   2. No audit write — adapter wraps with `runWithAudit`.
 *   3. Tenant arrives as a narrow `{ id }` projection.
 *   4. Role arrives via `ctx.role`; never from input.
 *   5. Defense-in-depth role gate (owner+staff) inside the service.
 *
 * Concurrency:
 *   - Per-product advisory lock acquired up front:
 *     `pg_advisory_xact_lock(hashtext('images:' || tenantId || ':' ||
 *      productId))`. Released at tx commit/rollback. Distinct prefix
 *     from `product_variants:` so image mutations don't serialize
 *     against variant mutations on the same product.
 *   - OCC anchored on the parent product row. UPDATE products SET
 *     updated_at = now() WHERE id, tenant_id, deleted_at IS NULL,
 *     OCC matches. Empty result → disambiguate gone vs stale.
 *
 * Per-product cap (10 images): re-counted INSIDE the lock window so
 * two concurrent uploaders racing to the cap correctly serialize and
 * the second sees count >= 10. Belt to the per-row uniqueness braces
 * which can't span rows.
 *
 * Duplicate detection:
 *   - Proactive probe: SELECT id FROM product_images WHERE
 *     product_id = $productId AND fingerprint_sha256 = $fp. Hit →
 *     CONFLICT with existingImageId on `cause` for the route handler
 *     to echo as the wire convenience field.
 *   - Race-loss fallback: pg 23505 on
 *     `product_images_product_fingerprint_unique` translates to the
 *     same CONFLICT. The fingerprint of the bytes is stable, so a
 *     concurrent insert with the same bytes is a duplicate by
 *     definition.
 *
 * Storage upload flow:
 *   1. processImage produces the 16 ProcessedToUpload entries.
 *   2. INSERT the row with the derivatives ledger BEFORE attempting
 *      uploads — the row is the source of truth, and an upload
 *      failure rolls back via row-DELETE + best-effort key cleanup.
 *   3. Promise.allSettled the 16 puts. Track successfulKeys.
 *   4. Any upload failed → DELETE the row (rolls back the insert in
 *      the same tx); best-effort delete the successful keys; throw
 *      INTERNAL_SERVER_ERROR `image_storage_failed`.
 *
 * Failure mapping (closed-set wire messages):
 *   - product missing → NOT_FOUND `product_not_found`.
 *   - OCC mismatch → `StaleWriteError("upload_product_image")`.
 *   - count >= 10 → BAD_REQUEST `image_count_exceeded`.
 *   - duplicate fingerprint → CONFLICT `image_duplicate_in_product`
 *     with `cause = { existingImageId }`.
 *   - ImageValidationError from Block 3 → BAD_REQUEST with the code.
 *   - StorageBackendError → INTERNAL_SERVER_ERROR `image_storage_failed`.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { products, productImages } from "@/server/db/schema/catalog";
import { tenants } from "@/server/db/schema/tenants";
import { localizedTextPartial } from "@/lib/i18n/localized";
import { StaleWriteError } from "@/server/audit/error-codes";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import { getStorageAdapter, type StorageAdapter } from "@/server/storage";
import { processImage } from "./process";
import { ImageValidationError } from "./validate";
import { extractPgImageFingerprintViolation } from "./pg-error-helpers";
import {
  buildImageAuditSnapshot,
  type ImageAuditSnapshot,
} from "./audit-snapshot";
import type { ImageDerivative } from "@/server/db/schema/_types";

const MAX_IMAGES_PER_PRODUCT = 10;
const SLUG_SHAPE = /^[a-z0-9-]{1,64}$/;

export interface UploadProductImageTenantInfo {
  id: string;
}

export const UploadProductImageInputSchema = z
  .object({
    productId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    /** Base64-encoded original bytes. Decoded inside the service. */
    bytes: z.string(),
    /** Optional explicit position. Default: append at end. */
    position: z.number().int().nonnegative().optional(),
    altText: localizedTextPartial({ max: 200 }).optional(),
  })
  .strict();

export type UploadProductImageInput = z.input<
  typeof UploadProductImageInputSchema
>;

export interface UploadProductImageResult {
  before: null;
  after: ImageAuditSnapshot;
  image: {
    id: string;
    productId: string;
    position: number;
    version: number;
    fingerprintSha256: string;
    storageKey: string;
    originalFormat: string;
    originalWidth: number;
    originalHeight: number;
    originalBytes: number;
    derivatives: ImageDerivative[];
    altText: { en?: string | undefined; ar?: string | undefined } | null;
    createdAt: Date;
    updatedAt: Date;
  };
}

export async function uploadProductImage(
  tx: Tx,
  tenant: UploadProductImageTenantInfo,
  role: Role,
  input: UploadProductImageInput,
  adapter: StorageAdapter = getStorageAdapter(),
): Promise<UploadProductImageResult> {
  if (!isWriteRole(role)) {
    throw new Error("uploadProductImage: role not permitted");
  }
  const parsed = UploadProductImageInputSchema.parse(input);

  // Per-product advisory lock — distinct prefix from variants so image
  // mutations don't serialize against option/variant mutations.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('images:' || ${tenant.id} || ':' || ${parsed.productId}))`,
  );

  // OCC-anchored UPDATE on products. Empty result → disambiguate.
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
      slug: products.slug,
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
    throw new StaleWriteError("upload_product_image");
  }
  const productRow = updatedRows[0]!;

  // Per-product cap re-counted inside the lock window.
  const existingRows = await tx
    .select({
      id: productImages.id,
      position: productImages.position,
      fingerprintSha256: productImages.fingerprintSha256,
    })
    .from(productImages)
    .where(
      and(
        eq(productImages.tenantId, tenant.id),
        eq(productImages.productId, parsed.productId),
      ),
    );
  if (existingRows.length >= MAX_IMAGES_PER_PRODUCT) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "image_count_exceeded",
    });
  }

  // Decode base64 → Buffer (route handler in Block 5b base64-encodes
  // before calling so this is the single decode site).
  let originalBytes: Buffer;
  try {
    originalBytes = Buffer.from(parsed.bytes, "base64");
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "image_unsupported_format",
    });
  }
  if (originalBytes.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "image_unsupported_format",
    });
  }

  // SHA-256 the input bytes for proactive duplicate detection. We
  // compute it twice intentionally — once here for the probe, once
  // inside processImage for the row's `fingerprint_sha256` column.
  // The two values are byte-equivalent by construction.
  const fingerprint = createHash("sha256")
    .update(originalBytes)
    .digest("hex");

  const dupHits = await tx
    .select({ id: productImages.id })
    .from(productImages)
    .where(
      and(
        eq(productImages.tenantId, tenant.id),
        eq(productImages.productId, parsed.productId),
        eq(productImages.fingerprintSha256, fingerprint),
      ),
    )
    .limit(1);
  if (dupHits.length > 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "image_duplicate_in_product",
      cause: { existingImageId: dupHits[0]!.id },
    });
  }

  // Read the tenant slug. Server-trusted (DB lookup, never input).
  const tenantRows = await tx
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenant.id))
    .limit(1);
  const tenantSlug = tenantRows[0]?.slug;
  if (!tenantSlug || !SLUG_SHAPE.test(tenantSlug)) {
    // Tenant row vanished or has a malformed slug — operator-config
    // problem. INTERNAL is correct.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "image_storage_failed",
    });
  }
  if (!SLUG_SHAPE.test(productRow.slug)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "image_storage_failed",
    });
  }

  // Compute the position to assign. Default = append after current max.
  const currentPositions = existingRows.map((r) => r.position);
  const nextPosition = currentPositions.length === 0
    ? 0
    : Math.max(...currentPositions) + 1;
  const position = parsed.position ?? nextPosition;

  // Process. Throws ImageValidationError on rejection — translate.
  let processed;
  try {
    processed = await processImage(originalBytes, {
      tenantSlug,
      productSlug: productRow.slug,
      position,
      version: 1,
    });
  } catch (err) {
    if (err instanceof ImageValidationError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.code });
    }
    throw err;
  }

  // Locate the original-entry's storage key from the toUpload list.
  const originalEntry = processed.toUpload.find((u) => u.size === "original");
  if (!originalEntry) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "image_storage_failed",
    });
  }

  // INSERT the row first. If the unique violation fires (a concurrent
  // uploader landed the same bytes between our probe and our insert),
  // we surface the same closed-set CONFLICT.
  let insertedId: string;
  let insertedAt: Date;
  let insertedUpdatedAt: Date;
  try {
    const inserted = await tx
      .insert(productImages)
      .values({
        tenantId: tenant.id,
        productId: parsed.productId,
        position,
        version: 1,
        fingerprintSha256: processed.fingerprintSha256,
        storageKey: originalEntry.key,
        originalFormat: processed.originalFormat,
        originalWidth: processed.originalWidth,
        originalHeight: processed.originalHeight,
        originalBytes: processed.originalBytes,
        derivatives: processed.derivatives,
        altText: parsed.altText ?? null,
      })
      .returning({
        id: productImages.id,
        createdAt: productImages.createdAt,
        updatedAt: productImages.updatedAt,
      });
    insertedId = inserted[0]!.id;
    insertedAt = inserted[0]!.createdAt;
    insertedUpdatedAt = inserted[0]!.updatedAt;
  } catch (err) {
    if (extractPgImageFingerprintViolation(err)) {
      // Race-loss path — winner already inserted with these bytes.
      // Look up its id so the wire shape matches the proactive probe.
      const winner = await tx
        .select({ id: productImages.id })
        .from(productImages)
        .where(
          and(
            eq(productImages.tenantId, tenant.id),
            eq(productImages.productId, parsed.productId),
            eq(productImages.fingerprintSha256, processed.fingerprintSha256),
          ),
        )
        .limit(1);
      throw new TRPCError({
        code: "CONFLICT",
        message: "image_duplicate_in_product",
        cause: { existingImageId: winner[0]?.id ?? null },
      });
    }
    throw err;
  }

  // Upload all 16 entries. Track which ones succeeded so we can clean
  // up partial state on failure.
  const results = await Promise.allSettled(
    processed.toUpload.map((u) => adapter.put(u.key, u.bytes, u.contentType)),
  );
  const successfulKeys: string[] = [];
  let anyFailed = false;
  for (let i = 0; i < results.length; i++) {
    if (results[i]!.status === "fulfilled") {
      successfulKeys.push(processed.toUpload[i]!.key);
    } else {
      anyFailed = true;
    }
  }

  if (anyFailed) {
    // Roll back the row INSIDE the tx — committing the row without
    // its files would leave a ghost ledger entry the storefront can't
    // resolve.
    await tx
      .delete(productImages)
      .where(
        and(
          eq(productImages.id, insertedId),
          eq(productImages.tenantId, tenant.id),
        ),
      );
    // Best-effort cleanup of the partial uploads. delete() is
    // idempotent per Block 2's contract; failures here are
    // Sentry-captured but do NOT throw — we already have a wire-
    // shaped failure to surface.
    await Promise.allSettled(
      successfulKeys.map((k) => adapter.delete(k)),
    ).catch(() => {});
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "image_storage_failed",
    });
  }

  const auditAfter = buildImageAuditSnapshot({
    imageId: insertedId,
    fingerprintSha256: processed.fingerprintSha256,
    position,
    derivatives: processed.derivatives,
    originalFormat: processed.originalFormat,
    productId: parsed.productId,
  });

  return {
    before: null,
    after: auditAfter,
    image: {
      id: insertedId,
      productId: parsed.productId,
      position,
      version: 1,
      fingerprintSha256: processed.fingerprintSha256,
      storageKey: originalEntry.key,
      originalFormat: processed.originalFormat,
      originalWidth: processed.originalWidth,
      originalHeight: processed.originalHeight,
      originalBytes: processed.originalBytes,
      derivatives: processed.derivatives,
      altText: parsed.altText ?? null,
      createdAt: insertedAt,
      updatedAt: insertedUpdatedAt,
    },
  };
}

