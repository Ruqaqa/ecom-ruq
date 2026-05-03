/**
 * Pre-upload client validator. Pure — no React, no `Image()` decode,
 * no async APIs.
 *
 * Only catches what the browser can verify locally without I/O:
 *   - file size against `MAX_ORIGINAL_IMAGE_BYTES`
 *   - MIME type against `ALLOWED_MIME_TYPES`, with an extension
 *     fallback for iOS share-sheet quirks (`file.type` is sometimes
 *     empty when the user shares a photo from the Photos app).
 *
 * Dimension checks (`image_too_small`, `image_dimensions_exceeded`),
 * format-validity (`image_corrupt`), duplicate-fingerprint, and
 * count-cap are all server-only — Sharp decodes the bytes
 * authoritatively in `process.ts`.
 */
import { MAX_ORIGINAL_IMAGE_BYTES, ALLOWED_MIME_TYPES } from "./limits";

export type ClientValidationCode = "too_large" | "unsupported_format";
export type ClientValidationResult =
  | { ok: true }
  | { ok: false; code: ClientValidationCode };

export function validateClientUpload(file: File): ClientValidationResult {
  if (file.size > MAX_ORIGINAL_IMAGE_BYTES) {
    return { ok: false, code: "too_large" };
  }
  const mimeOk = (ALLOWED_MIME_TYPES as readonly string[]).includes(file.type);
  if (!mimeOk) {
    const name = file.name.toLowerCase();
    const extOk =
      name.endsWith(".jpg") ||
      name.endsWith(".jpeg") ||
      name.endsWith(".png") ||
      name.endsWith(".webp");
    if (!extOk) return { ok: false, code: "unsupported_format" };
  }
  return { ok: true };
}
