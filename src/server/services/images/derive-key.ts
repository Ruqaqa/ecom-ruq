/**
 * Chunk 1a.7.1 Block 3 — descriptive storage-key generator.
 *
 * Pattern: "<tenant-slug>/<product-slug>-<position>-v<version>-<size>.<ext>"
 *
 * tenant slug is server-trusted (looked up from DB by tenant id, never
 * supplied by the caller). product slug is from the row. Both are
 * re-validated against `^[a-z0-9-]{1,64}$` here even though the DB
 * enforces it (defense in depth — mirrors prd.md `slugSchema`).
 *
 * Position is the integer column on `product_images` (0 = cover).
 * Version is the monotonic counter on the same row (v1 on insert,
 * bumped on replace).
 *
 * Size "original" is the only non-derivative size — its key matches
 * the value stored in `product_images.storageKey`.
 */
import { StorageBackendError, assertSafeStorageKey } from "@/server/storage";
import { FORMAT_EXT, type DerivativeFormat, type OriginalFormat } from "./constants";

const SLUG_SHAPE = /^[a-z0-9-]{1,64}$/;

export interface DeriveKeyOpts {
  tenantSlug: string;
  productSlug: string;
  position: number;
  version: number;
  size: "original" | "thumb" | "card" | "page" | "zoom" | "share";
  format: DerivativeFormat | OriginalFormat;
}

export function deriveStorageKey(opts: DeriveKeyOpts): string {
  if (!SLUG_SHAPE.test(opts.tenantSlug)) {
    throw new StorageBackendError("upload_failed", "tenant-slug-shape");
  }
  if (!SLUG_SHAPE.test(opts.productSlug)) {
    throw new StorageBackendError("upload_failed", "product-slug-shape");
  }
  if (!Number.isInteger(opts.position) || opts.position < 0 || opts.position > 9999) {
    throw new StorageBackendError("upload_failed", "position-shape");
  }
  if (!Number.isInteger(opts.version) || opts.version < 1 || opts.version > 9999) {
    throw new StorageBackendError("upload_failed", "version-shape");
  }
  const ext = FORMAT_EXT[opts.format as keyof typeof FORMAT_EXT];
  if (!ext) {
    throw new StorageBackendError("upload_failed", "format-shape");
  }
  const key = `${opts.tenantSlug}/${opts.productSlug}-${opts.position}-v${opts.version}-${opts.size}.${ext}`;
  // Defense in depth: run the same validator the storage adapters use.
  assertSafeStorageKey(key);
  return key;
}
