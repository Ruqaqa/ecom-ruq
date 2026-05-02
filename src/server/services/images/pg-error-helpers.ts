/**
 * pg error helpers for image services (chunk 1a.7.1).
 *
 * Mirrors the variants / categories / products precedents: a thin
 * wrapper over `findPgErrorRecord` that recognises the per-product
 * fingerprint duplicate violation.
 *
 * Race-loss path: a concurrent uploadProductImage with byte-equal input
 * loses to the winner and surfaces pg 23505 on
 * `product_images_product_fingerprint_unique`. The service catches this
 * and translates to TRPCError({code:'CONFLICT', message:'image_duplicate_in_product'}),
 * matching the proactive duplicate-probe path's wire shape.
 */
import { findPgErrorRecord } from "@/server/db/pg-errors";

export function extractPgUniqueViolation(
  err: unknown,
  constraintName: string,
): boolean {
  const rec = findPgErrorRecord(err);
  return rec?.code === "23505" && rec.constraint_name === constraintName;
}

export function extractPgImageFingerprintViolation(err: unknown): boolean {
  return extractPgUniqueViolation(
    err,
    "product_images_product_fingerprint_unique",
  );
}
