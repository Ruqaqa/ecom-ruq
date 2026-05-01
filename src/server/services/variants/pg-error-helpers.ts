/**
 * pg error helpers for variant services (chunk 1a.5.1).
 *
 * Mirrors the categories/products versions: a thin wrapper over
 * `findPgErrorRecord` that recognises the named unique-violation. SKU
 * collisions on `product_variants_tenant_sku_unique` translate into the
 * typed `SkuTakenError` so the audit mapper classifies them as
 * `'conflict'` (vs the default `'internal_error'`) and the wire layer
 * surfaces a closed-set `sku_taken` message instead of a raw 500.
 */
import { findPgErrorRecord } from "@/server/db/pg-errors";

export function extractPgUniqueViolation(
  err: unknown,
  constraintName: string,
): boolean {
  const rec = findPgErrorRecord(err);
  return rec?.code === "23505" && rec.constraint_name === constraintName;
}

export function extractPgSkuViolation(err: unknown): boolean {
  return extractPgUniqueViolation(
    err,
    "product_variants_tenant_sku_unique",
  );
}
