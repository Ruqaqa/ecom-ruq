/**
 * Chunk 1a.7.1 Block 3 — image pipeline constants.
 *
 * Five sizes × three formats = 15 derivatives + the (re-encoded)
 * original = 16 entries per uploaded image.
 *
 * Quality picks come from the brief's defaults — AVIF q70 / WebP q75 /
 * JPEG q82. They should be revisited when LCP is profiled on the
 * storefront and not before.
 */

// Re-exported for back-compat with existing imports in process.ts; new
// code imports from @/lib/images/limits.
import {
  MAX_ORIGINAL_IMAGE_BYTES,
  MIN_LONG_EDGE_PX as MIN_LONG_EDGE_PX_SHARED,
  SHARP_DECOMPRESSION_LIMIT_PIXELS as SHARP_DECOMPRESSION_LIMIT_PIXELS_SHARED,
} from "@/lib/images/limits";

export const SHARP_DECOMPRESSION_LIMIT_PIXELS =
  SHARP_DECOMPRESSION_LIMIT_PIXELS_SHARED;

export const ORIGINAL_BYTES_LIMIT = MAX_ORIGINAL_IMAGE_BYTES;

export const MIN_LONG_EDGE_PX = MIN_LONG_EDGE_PX_SHARED;

// Per-product cap. Enforced in upload (image_count_exceeded) and reorder (Zod schema).
export const MAX_PRODUCT_IMAGE_COUNT = 10;

export type DerivativeSize = "thumb" | "card" | "page" | "zoom" | "share";
export type DerivativeFormat = "avif" | "webp" | "jpeg";
export type OriginalFormat = "jpeg" | "png" | "webp";

export interface SizeSpec {
  /** Long-edge constraint; aspect-preserved unless `fit` says otherwise. */
  width: number;
  height: number;
  /** sharp resize fit. `share` is fixed-aspect (cover); the rest are inside. */
  fit: "inside" | "cover";
}

export const SIZE_SPECS: Record<DerivativeSize, SizeSpec> = {
  thumb: { width: 200, height: 200, fit: "inside" },
  card: { width: 600, height: 600, fit: "inside" },
  page: { width: 1200, height: 1200, fit: "inside" },
  zoom: { width: 2000, height: 2000, fit: "inside" },
  // Open-graph share card. Fixed 1200×630 — cover-cropped.
  share: { width: 1200, height: 630, fit: "cover" },
};

export const FORMAT_QUALITY: Record<DerivativeFormat, number> = {
  avif: 70,
  webp: 75,
  jpeg: 82,
};

export const FORMAT_CONTENT_TYPE: Record<DerivativeFormat | "png", string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
};

export const FORMAT_EXT: Record<DerivativeFormat | "png", string> = {
  avif: "avif",
  webp: "webp",
  jpeg: "jpg",
  png: "png",
};
