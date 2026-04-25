/**
 * Product slug utilities. Shared between client (live validation + auto-
 * derivation in the admin form) and server (Zod schema at
 * src/server/services/products/create-product.ts). The regex below is
 * the single source of truth — both sides import it; validation cannot
 * drift.
 *
 * Slug shape invariant (enforced by server Zod + mirrored here for UX):
 *   - 1–120 characters
 *   - [a-z0-9-]+ only
 *   - No leading or trailing hyphen
 *   - No consecutive hyphens
 *
 * Server Zod is authoritative. This module is defense-in-depth + UX.
 */

import { z } from "zod";

export const SLUG_REGEX = /^[a-z0-9-]+$/;
export const SLUG_MAX = 120;

/**
 * Deterministic Latin slug from arbitrary user text. Empty string if
 * input contains no slug-safe characters. Caller decides what to do
 * with empty (admin form shows empty slug, not error).
 */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    // Unicode decomposition: "café" → "cafe" (strip combining marks).
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    // Non-[a-z0-9] → hyphen.
    .replace(/[^a-z0-9]+/g, "-")
    // Collapse repeated hyphens.
    .replace(/-+/g, "-")
    // Trim leading/trailing.
    .replace(/^-+|-+$/g, "")
    // Cap length (post-trim so we don't end on a hyphen from the cut).
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

export type SlugValidationError =
  | "empty"
  | "too_long"
  | "invalid_chars"
  | "leading_hyphen"
  | "trailing_hyphen"
  | "consecutive_hyphens";

/**
 * Returns null if the raw slug is shape-valid, else a specific error
 * key. Error keys are i18n message keys (see en.json / ar.json under
 * `admin.products.create.slugError`). Client renders the error inline;
 * server Zod rejects with errorCode: 'validation_failed' regardless of
 * which branch trips.
 */
export function validateSlug(raw: string): SlugValidationError | null {
  if (raw.length === 0) return "empty";
  if (raw.length > SLUG_MAX) return "too_long";
  if (!SLUG_REGEX.test(raw)) return "invalid_chars";
  if (raw.startsWith("-")) return "leading_hyphen";
  if (raw.endsWith("-")) return "trailing_hyphen";
  if (raw.includes("--")) return "consecutive_hyphens";
  return null;
}

/**
 * Single Zod schema for slug input. Used by every service / MCP tool
 * that accepts a slug (create, update, future variants/categories).
 * Drift would let one transport accept a slug shape another transport
 * would reject — keep this the single source of truth.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(SLUG_MAX)
  .regex(SLUG_REGEX)
  .refine((s) => validateSlug(s) === null, {
    message: "slug: invalid shape (leading/trailing/consecutive hyphen)",
  });
