/**
 * Chunk 1a.7.1 Block 3 — image processing pipeline.
 *
 * Pure function: bytes-in → ProcessedImage. No DB, no storage, no
 * tenant context. The caller (Block 4 service) handles all of that.
 *
 * Flow:
 *   1. Magic-byte sniff (validate.ts) — reject unsupported formats.
 *   2. Original-bytes size cap (10 MB).
 *   3. sharp(buffer, { limitInputPixels, sequentialRead, failOn: 'warning' })
 *      .metadata() probe — reject `image_dimensions_exceeded` BEFORE any
 *      pixel allocation if width × height > 25M.
 *   4. Reject `image_too_small` if max(width, height) < 1000.
 *   5. SHA-256 the original input bytes (pre-strip, pre-rotate) for
 *      duplicate detection.
 *   6. For each (size, format) of 5 × 3, run sharp(...).rotate().resize(
 *      ...).<format>({ quality }) → buffer + width/height. NEVER call
 *      withMetadata — sharp drops metadata by default after re-encode.
 *      That's the EXIF/ICC/XMP/IPTC strip.
 *   7. Re-encode the original through sharp(...).rotate().<originalFormat>()
 *      so it carries no metadata either. PRD requires the original to be
 *      retained for re-derivation; nothing requires it to keep EXIF/ICC.
 *      Stripping closes the polyglot defense path entirely.
 *
 * Returns: original (re-encoded bytes + dimensions + format), 16 entries
 * to upload (1 original + 15 derivatives), and the JSONB ledger payload
 * for the DB row.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ImageDerivative } from "@/server/db/schema/_types";
import {
  FORMAT_CONTENT_TYPE,
  FORMAT_QUALITY,
  MIN_LONG_EDGE_PX,
  ORIGINAL_BYTES_LIMIT,
  SHARP_DECOMPRESSION_LIMIT_PIXELS,
  SIZE_SPECS,
  type DerivativeFormat,
  type DerivativeSize,
  type OriginalFormat,
} from "./constants";
import { deriveStorageKey } from "./derive-key";
import { ImageValidationError, sniffFormat } from "./validate";

const SHARP_INPUT_OPTS = {
  limitInputPixels: SHARP_DECOMPRESSION_LIMIT_PIXELS,
  sequentialRead: true,
  failOn: "warning" as const,
};

export interface ProcessImageOpts {
  /** Server-trusted tenant slug (looked up by DB, never from input). */
  tenantSlug: string;
  /** Slug of the product the image belongs to. */
  productSlug: string;
  /** 0-based position on the product. */
  position: number;
  /** Monotonic version on the row (v1 at insert, bumped on replace). */
  version: number;
}

export interface ProcessedToUpload {
  key: string;
  bytes: Buffer;
  contentType: string;
  size: "original" | DerivativeSize;
  format: DerivativeFormat | OriginalFormat;
  width: number;
  height: number;
}

export interface ProcessedImage {
  fingerprintSha256: string;
  originalFormat: OriginalFormat;
  originalWidth: number;
  originalHeight: number;
  /** The post-strip, post-re-encode original byte length. */
  originalBytes: number;
  /** 16 entries: 1 re-encoded original + 15 derivatives. */
  toUpload: ProcessedToUpload[];
  /**
   * Derivatives-only ledger for the DB row's `derivatives` JSONB column.
   * The original entry is NOT included here — the row carries the
   * original separately via `storageKey` + `originalFormat`/etc.
   */
  derivatives: ImageDerivative[];
}

const SIZES: DerivativeSize[] = ["thumb", "card", "page", "zoom", "share"];
const FORMATS: DerivativeFormat[] = ["avif", "webp", "jpeg"];

export async function processImage(
  inputBytes: Buffer,
  opts: ProcessImageOpts,
): Promise<ProcessedImage> {
  if (inputBytes.length > ORIGINAL_BYTES_LIMIT) {
    throw new ImageValidationError("image_too_large");
  }
  const sniffed = sniffFormat(inputBytes); // throws image_unsupported_format

  // Probe metadata WITHOUT decoding pixels. limitInputPixels in the
  // sharp constructor caps any subsequent decode, but we want to reject
  // BEFORE allocating decoder buffers if the declared dimensions are
  // huge. Read the declared width/height from the format header.
  let declared: sharp.Metadata;
  try {
    declared = await sharp(inputBytes, SHARP_INPUT_OPTS).metadata();
  } catch (err) {
    if (
      err instanceof Error &&
      /input.*pixel.*limit|exceed.*limit|input image exceed/i.test(err.message)
    ) {
      throw new ImageValidationError("image_dimensions_exceeded");
    }
    throw new ImageValidationError("image_corrupt");
  }
  const dw = declared.width ?? 0;
  const dh = declared.height ?? 0;
  if (!dw || !dh) {
    throw new ImageValidationError("image_corrupt");
  }
  if (dw * dh > SHARP_DECOMPRESSION_LIMIT_PIXELS) {
    throw new ImageValidationError("image_dimensions_exceeded");
  }
  if (Math.max(dw, dh) < MIN_LONG_EDGE_PX) {
    throw new ImageValidationError("image_too_small");
  }

  const fingerprint = createHash("sha256").update(inputBytes).digest("hex");

  // Re-encode the original through sharp(.).rotate().<sniffed>() — no
  // metadata, EXIF orientation baked in. This closes the polyglot
  // path: even if the input had appended HTML, the output is a clean
  // round-trip.
  const reOriginal = await reEncodeOriginal(inputBytes, sniffed);

  const toUpload: ProcessedToUpload[] = [];
  const derivatives: ImageDerivative[] = [];

  // Original entry (not in `derivatives` ledger; tracked on the DB row).
  toUpload.push({
    key: deriveStorageKey({
      tenantSlug: opts.tenantSlug,
      productSlug: opts.productSlug,
      position: opts.position,
      version: opts.version,
      size: "original",
      format: sniffed,
    }),
    bytes: reOriginal.bytes,
    contentType: FORMAT_CONTENT_TYPE[sniffed],
    size: "original",
    format: sniffed,
    width: reOriginal.width,
    height: reOriginal.height,
  });

  // 15 derivatives: 5 sizes × 3 formats. Run sequentially to keep peak
  // memory bounded — each sharp instance holds the decoded bitmap; on a
  // 2000×2000 RGB image that's ~12 MB. Concurrency = 15 would push past
  // 180 MB on a single upload.
  for (const size of SIZES) {
    for (const format of FORMATS) {
      const derived = await renderDerivative(inputBytes, size, format);
      const key = deriveStorageKey({
        tenantSlug: opts.tenantSlug,
        productSlug: opts.productSlug,
        position: opts.position,
        version: opts.version,
        size,
        format,
      });
      toUpload.push({
        key,
        bytes: derived.bytes,
        contentType: FORMAT_CONTENT_TYPE[format],
        size,
        format,
        width: derived.width,
        height: derived.height,
      });
      derivatives.push({
        size,
        format,
        width: derived.width,
        height: derived.height,
        storageKey: key,
        bytes: derived.bytes.length,
      });
    }
  }

  return {
    fingerprintSha256: fingerprint,
    originalFormat: sniffed,
    originalWidth: reOriginal.width,
    originalHeight: reOriginal.height,
    originalBytes: reOriginal.bytes.length,
    toUpload,
    derivatives,
  };
}

async function reEncodeOriginal(
  inputBytes: Buffer,
  format: OriginalFormat,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  // Re-encode via sharp; the format chain matches the input. .rotate()
  // with no args bakes EXIF orientation into pixels. No withMetadata —
  // sharp drops EXIF/ICC/XMP/IPTC by default.
  const pipeline = sharp(inputBytes, SHARP_INPUT_OPTS).rotate();
  let withFormat: sharp.Sharp;
  if (format === "jpeg") withFormat = pipeline.jpeg({ quality: 90, mozjpeg: true });
  else if (format === "png") withFormat = pipeline.png();
  else withFormat = pipeline.webp({ quality: 90 });
  try {
    const result = await withFormat.toBuffer({ resolveWithObject: true });
    return { bytes: result.data, width: result.info.width, height: result.info.height };
  } catch (err) {
    if (err instanceof Error && /input.*pixel.*limit|exceed.*limit/i.test(err.message)) {
      throw new ImageValidationError("image_dimensions_exceeded");
    }
    throw new ImageValidationError("image_corrupt");
  }
}

async function renderDerivative(
  inputBytes: Buffer,
  size: DerivativeSize,
  format: DerivativeFormat,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const spec = SIZE_SPECS[size];
  let pipeline = sharp(inputBytes, SHARP_INPUT_OPTS)
    .rotate()
    .resize(spec.width, spec.height, { fit: spec.fit, withoutEnlargement: false });
  switch (format) {
    case "avif":
      pipeline = pipeline.avif({ quality: FORMAT_QUALITY.avif });
      break;
    case "webp":
      pipeline = pipeline.webp({ quality: FORMAT_QUALITY.webp });
      break;
    case "jpeg":
      pipeline = pipeline.jpeg({ quality: FORMAT_QUALITY.jpeg, mozjpeg: true });
      break;
  }
  try {
    const result = await pipeline.toBuffer({ resolveWithObject: true });
    return { bytes: result.data, width: result.info.width, height: result.info.height };
  } catch (err) {
    if (err instanceof Error && /input.*pixel.*limit|exceed.*limit/i.test(err.message)) {
      throw new ImageValidationError("image_dimensions_exceeded");
    }
    throw new ImageValidationError("image_corrupt");
  }
}
