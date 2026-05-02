/**
 * `replaceProductImage` — admin product image replace (chunk 1a.7.1).
 *
 * Versioned-key replace, NOT overwrite-in-place: the new bytes get a
 * v(N+1) key prefix so CDN cache staleness + mid-replace partial-
 * content windows are eliminated. The old keys are cleaned up
 * best-effort AFTER the row UPDATE commits.
 *
 * Destructive (overwrites file content + bumps version); requires
 * `confirm: true` per CLAUDE.md §6.
 *
 * Skips the duplicate-fingerprint check — operator explicitly intends
 * to replace, even with the same bytes (e.g., re-applying a previous
 * version).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { products, productImages } from "@/server/db/schema/catalog";
import { tenants } from "@/server/db/schema/tenants";
import { StaleWriteError } from "@/server/audit/error-codes";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import { getStorageAdapter, type StorageAdapter } from "@/server/storage";
import { captureMessage, summarizeErrorForObs } from "@/server/obs/sentry";
import { processImage } from "./process";
import { ImageValidationError } from "./validate";
import {
  buildImageAuditSnapshot,
  type ImageAuditSnapshot,
} from "./audit-snapshot";
import type { ImageDerivative } from "@/server/db/schema/_types";

const SLUG_SHAPE = /^[a-z0-9-]{1,64}$/;

export interface ReplaceProductImageTenantInfo {
  id: string;
}

export const ReplaceProductImageInputSchema = z
  .object({
    imageId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    bytes: z.string(),
    confirm: z.literal(true),
  })
  .strict();

export type ReplaceProductImageInput = z.input<
  typeof ReplaceProductImageInputSchema
>;

export interface ReplaceProductImageResult {
  before: ImageAuditSnapshot;
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

export async function replaceProductImage(
  tx: Tx,
  tenant: ReplaceProductImageTenantInfo,
  role: Role,
  input: ReplaceProductImageInput,
  adapter: StorageAdapter = getStorageAdapter(),
): Promise<ReplaceProductImageResult> {
  if (!isWriteRole(role)) {
    throw new Error("replaceProductImage: role not permitted");
  }
  const parsed = ReplaceProductImageInputSchema.parse(input);

  // SELECT the image first to discover productId for the lock.
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
  const oldImage = imageRows[0]!;
  const productId = oldImage.productId;

  // Per-product advisory lock.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('images:' || ${tenant.id} || ':' || ${productId}))`,
  );

  // OCC-anchored UPDATE on products. Empty result → disambiguate.
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
    throw new StaleWriteError("replace_product_image");
  }
  const productRow = updatedRows[0]!;

  // Decode + process new bytes.
  let newBytes: Buffer;
  try {
    newBytes = Buffer.from(parsed.bytes, "base64");
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "image_unsupported_format",
    });
  }
  if (newBytes.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "image_unsupported_format",
    });
  }

  const tenantRows = await tx
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenant.id))
    .limit(1);
  const tenantSlug = tenantRows[0]?.slug;
  if (!tenantSlug || !SLUG_SHAPE.test(tenantSlug)) {
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

  const newVersion = oldImage.version + 1;

  let processed;
  try {
    processed = await processImage(newBytes, {
      tenantSlug,
      productSlug: productRow.slug,
      position: oldImage.position,
      version: newVersion,
    });
  } catch (err) {
    if (err instanceof ImageValidationError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.code });
    }
    throw err;
  }

  // Compute the fingerprint of the new bytes for the row's column.
  const newFingerprint = createHash("sha256")
    .update(newBytes)
    .digest("hex");

  const newOriginalEntry = processed.toUpload.find((u) => u.size === "original");
  if (!newOriginalEntry) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "image_storage_failed",
    });
  }

  // Upload to NEW keys first. Old keys/row remain serviceable until we
  // commit the row UPDATE. Any upload failure → best-effort cleanup of
  // partial new uploads, then throw — old state is intact.
  const results = await Promise.allSettled(
    processed.toUpload.map((u) => adapter.put(u.key, u.bytes, u.contentType)),
  );
  const successfulNewKeys: string[] = [];
  let anyFailed = false;
  for (let i = 0; i < results.length; i++) {
    if (results[i]!.status === "fulfilled") {
      successfulNewKeys.push(processed.toUpload[i]!.key);
    } else {
      anyFailed = true;
    }
  }
  if (anyFailed) {
    await Promise.allSettled(
      successfulNewKeys.map((k) => adapter.delete(k)),
    ).catch(() => {});
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "image_storage_failed",
    });
  }

  // UPDATE the row in-place: bump version, swap content, refresh
  // updated_at.
  const updated = await tx
    .update(productImages)
    .set({
      version: newVersion,
      fingerprintSha256: newFingerprint,
      storageKey: newOriginalEntry.key,
      originalFormat: processed.originalFormat,
      originalWidth: processed.originalWidth,
      originalHeight: processed.originalHeight,
      originalBytes: processed.originalBytes,
      derivatives: processed.derivatives,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(productImages.id, parsed.imageId),
        eq(productImages.tenantId, tenant.id),
      ),
    )
    .returning({
      id: productImages.id,
      createdAt: productImages.createdAt,
      updatedAt: productImages.updatedAt,
    });

  // Capture old keys for post-update cleanup.
  const oldKeys = [
    oldImage.storageKey,
    ...(oldImage.derivatives as ImageDerivative[]).map((d) => d.storageKey),
  ];
  // Best-effort cleanup of the old version's files. Sentry-captured;
  // fire-and-forget so the request doesn't pay 16 round-trips of
  // latency. Identifier-shaped keys are scrubbed at the obs layer,
  // so we keep the capture to operation-name + counts + sample cause
  // (mirrors Block 7's `product_purge_storage_orphan` shape).
  Promise.allSettled(oldKeys.map((k) => adapter.delete(k)))
    .then((results) => {
      const failed = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (failed.length > 0) {
        captureMessage("image_replace_storage_orphan", {
          level: "warning",
          extra: {
            orphanCount: failed.length,
            totalKeys: oldKeys.length,
            sampleCause: summarizeErrorForObs(failed[0]?.reason),
          },
        });
      }
    })
    .catch(() => {});

  const auditBefore = buildImageAuditSnapshot({
    imageId: oldImage.id,
    fingerprintSha256: oldImage.fingerprintSha256,
    position: oldImage.position,
    derivatives: oldImage.derivatives as ImageDerivative[],
    originalFormat: oldImage.originalFormat,
    productId,
  });
  const auditAfter = buildImageAuditSnapshot({
    imageId: oldImage.id,
    fingerprintSha256: newFingerprint,
    position: oldImage.position,
    derivatives: processed.derivatives,
    originalFormat: processed.originalFormat,
    productId,
  });

  return {
    before: auditBefore,
    after: auditAfter,
    image: {
      id: oldImage.id,
      productId,
      position: oldImage.position,
      version: newVersion,
      fingerprintSha256: newFingerprint,
      storageKey: newOriginalEntry.key,
      originalFormat: processed.originalFormat,
      originalWidth: processed.originalWidth,
      originalHeight: processed.originalHeight,
      originalBytes: processed.originalBytes,
      derivatives: processed.derivatives,
      altText: (oldImage.altText as
        | { en?: string | undefined; ar?: string | undefined }
        | null) ?? null,
      createdAt: updated[0]!.createdAt,
      updatedAt: updated[0]!.updatedAt,
    },
  };
}
