/**
 * Shared image-pipeline limits — single source of truth.
 *
 * Importable from both client (`validate-client-upload`, `upload-client`)
 * and server (`@/server/services/images/process`, route handlers, the
 * GET-derivative content-type lookup). Keep this module pure and
 * dependency-free so client bundles do not pull in server code.
 *
 * Server-side `@/server/services/images/constants.ts` re-exports the
 * three numeric limits under their original names for back-compat with
 * existing imports in `process.ts`. New code imports from here.
 */
export const MAX_ORIGINAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MIN_LONG_EDGE_PX = 1000;
export const SHARP_DECOMPRESSION_LIMIT_PIXELS = 25_000_000;
export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];
