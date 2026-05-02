import { customType } from "drizzle-orm/pg-core";

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (v) => v,
  fromDriver: (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array)),
});

/**
 * One derivative file emitted by the image processing pipeline. The
 * `product_images.derivatives` JSONB column stores an array of these.
 *
 * Not an FK — the storefront renders explicit width/height per <img>
 * from this ledger so a single product_images row carries everything
 * needed to lay out a Picture element without a join.
 *
 * Five sizes × three formats = fifteen entries per image (the ORIGINAL
 * is tracked separately on the row's `storageKey` column, not in this
 * array, because the original is retained for re-derivation only and
 * never publicly served in 1a.7.1).
 */
export interface ImageDerivative {
  size: "thumb" | "card" | "page" | "zoom" | "share";
  format: "avif" | "webp" | "jpeg";
  width: number;
  height: number;
  storageKey: string;
  bytes: number;
}
