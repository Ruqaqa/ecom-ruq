/**
 * Chunk 1a.7.1 Block 3 — input validation (magic-byte sniff).
 *
 * Defense layer 1. The pipeline trusts neither the client-supplied
 * content-type header nor the file extension on a multipart upload;
 * everything is sniffed from the leading bytes.
 *
 * SVG is rejected here — sharp can render SVG which is a polyglot/XSS
 * vector (script tags, external entities). 1a.7.1 storefront only ever
 * serves derivatives that were re-encoded through sharp, but blocking
 * SVG at the door is the simpler defense.
 *
 * Polyglot defense: a file that begins with a JPEG header but contains
 * appended HTML/JS will pass the magic-byte check. The real defense is
 * the sharp re-encode in process.ts — every output is a fresh re-encode
 * that drops trailing data. The sniff is only a coarse early reject.
 */
import type { OriginalFormat } from "./constants";

export class ImageValidationError extends Error {
  readonly code: ImageValidationCode;
  constructor(code: ImageValidationCode) {
    super(code);
    this.name = "ImageValidationError";
    this.code = code;
  }
}

export type ImageValidationCode =
  | "image_unsupported_format"
  | "image_too_small"
  | "image_too_large"
  | "image_dimensions_exceeded"
  | "image_corrupt";

export function sniffFormat(bytes: Buffer): OriginalFormat {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "webp";
  }
  throw new ImageValidationError("image_unsupported_format");
}
