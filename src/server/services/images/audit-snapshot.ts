/**
 * Bounded audit snapshots for the image pipeline (chunk 1a.7.1).
 *
 * Mirrors the variants precedent at
 * `src/server/services/variants/audit-snapshot.ts`: the wire return for
 * image services carries the full materialised row (admin UI + caller
 * needs storage keys + the derivative ledger), but the append-only
 * audit chain takes a BOUNDED projection. Storage keys do NOT cross
 * into audit — they're operator-readable enough on the wire, and a
 * leaked key in PDPL-undeletable storage is a forensic-discovery
 * surface we don't want. Alt-text strings do NOT cross — only
 * presence flags (`hasEn`/`hasAr`).
 *
 * Per-image shape (security-ratified):
 *   { imageId, fingerprintSha256, position, derivativeCount,
 *     derivativeSizes (sorted, deduped), originalFormat, productId }
 *
 * No `hash` field. The variants snapshot uses a hash for content-
 * change detection across many rows; here the per-image
 * `fingerprintSha256` already serves as the per-image content fingerprint
 * (forensic correlator across upload/replace events on the same product).
 */
import type { ImageDerivative } from "@/server/db/schema/_types";

export interface ImageAuditInput {
  imageId: string;
  fingerprintSha256: string;
  position: number;
  derivatives: ReadonlyArray<ImageDerivative>;
  originalFormat: string;
  productId: string;
}

export interface ImageAuditSnapshot {
  imageId: string;
  fingerprintSha256: string;
  position: number;
  derivativeCount: number;
  derivativeSizes: ImageDerivative["size"][];
  originalFormat: string;
  productId: string;
}

export function buildImageAuditSnapshot(
  input: ImageAuditInput,
): ImageAuditSnapshot {
  const sizeSet = new Set<ImageDerivative["size"]>();
  for (const d of input.derivatives) sizeSet.add(d.size);
  const sortedSizes = [...sizeSet].sort();
  return {
    imageId: input.imageId,
    fingerprintSha256: input.fingerprintSha256,
    position: input.position,
    derivativeCount: input.derivatives.length,
    derivativeSizes: sortedSizes,
    originalFormat: input.originalFormat,
    productId: input.productId,
  };
}

/**
 * Alt-text presence flags only — strings never cross into audit.
 * Empty-string sides count as ABSENT (operators clearing one side via
 * the empty string should not produce a false `hasEn:true` signal).
 */
export interface AltTextAuditInput {
  imageId: string;
  altText:
    | { en?: string | undefined; ar?: string | undefined }
    | null;
}

export interface AltTextAuditSnapshot {
  imageId: string;
  hasEn: boolean;
  hasAr: boolean;
}

export function buildAltTextAuditSnapshot(
  input: AltTextAuditInput,
): AltTextAuditSnapshot {
  const en = input.altText?.en;
  const ar = input.altText?.ar;
  return {
    imageId: input.imageId,
    hasEn: typeof en === "string" && en.length > 0,
    hasAr: typeof ar === "string" && ar.length > 0,
  };
}

/**
 * Cover-swap snapshot — promoting an image to position 0 swaps with
 * the existing cover. Carries both image refs and their before
 * positions so investigators can reconstruct the swap from the audit
 * row alone.
 */
export interface CoverSwapAuditInput {
  productId: string;
  oldCoverImageId: string;
  newCoverImageId: string;
  oldCoverOldPosition: number;
  newCoverOldPosition: number;
}

export interface CoverSwapAuditSnapshot {
  productId: string;
  oldCoverImageId: string;
  newCoverImageId: string;
  oldCoverOldPosition: number;
  newCoverOldPosition: number;
}

export function buildCoverSwapAuditSnapshot(
  input: CoverSwapAuditInput,
): CoverSwapAuditSnapshot {
  return {
    productId: input.productId,
    oldCoverImageId: input.oldCoverImageId,
    newCoverImageId: input.newCoverImageId,
    oldCoverOldPosition: input.oldCoverOldPosition,
    newCoverOldPosition: input.newCoverOldPosition,
  };
}

/**
 * Variant-cover snapshot — `setVariantCoverImage` audit shape. Captures
 * the variant id and before/after coverImageId. Either side may be null
 * (clearing the cover lets the variant fall back to the product cover).
 */
export interface VariantCoverAuditInput {
  variantId: string;
  oldCoverImageId: string | null;
  newCoverImageId: string | null;
}

export interface VariantCoverAuditSnapshot {
  variantId: string;
  oldCoverImageId: string | null;
  newCoverImageId: string | null;
}

export function buildVariantCoverAuditSnapshot(
  input: VariantCoverAuditInput,
): VariantCoverAuditSnapshot {
  return {
    variantId: input.variantId,
    oldCoverImageId: input.oldCoverImageId,
    newCoverImageId: input.newCoverImageId,
  };
}
