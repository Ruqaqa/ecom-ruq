/**
 * Browser-side multipart upload wrappers for the admin photo surface.
 *
 * Why XHR not fetch: progress reporting. `fetch` exposes no
 * `upload.onprogress`; XHR does. Multipart body lets the route handlers
 * reuse the existing `req.formData()` parser from chunk 1a.7.1 Block 5b.
 *
 * Both wrappers return a discriminated union — never throw on
 * closed-set wire errors. Network and abort errors throw (caller
 * catches). Abort signal subscribes to `abort` events; on abort the
 * returned promise rejects with `Error("aborted")`.
 *
 * Note on abort: the server may finish processing the bytes it already
 * buffered; abort is a client-side cancel only. Acceptable trade-off —
 * admin-only surface, low volume.
 */

export type WireCode =
  | "image_too_small"
  | "image_too_large"
  | "image_unsupported_format"
  | "image_dimensions_exceeded"
  | "image_count_exceeded"
  | "image_corrupt"
  | "image_duplicate_in_product"
  | "image_storage_failed"
  | "product_not_found"
  | "image_not_found"
  | "stale_write"
  | "validation_failed"
  | "forbidden";

export interface ImageRow {
  id: string;
  productId: string;
  position: number;
  version: number;
  fingerprintSha256: string;
  storageKey: string;
  originalFormat: string;
  originalWidth: number;
  originalHeight: number;
  originalBytes: number;
  derivatives: Array<{
    size: "thumb" | "card" | "page" | "zoom" | "share";
    format: "avif" | "webp" | "jpeg";
    width: number;
    height: number;
    storageKey: string;
    bytes: number;
  }>;
  altText: { en?: string; ar?: string } | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export type UploadResult =
  | { ok: true; image: ImageRow }
  | { ok: false; code: WireCode; existingImageId?: string };

export type ReplaceResult =
  | { ok: true; image: ImageRow }
  | { ok: false; code: WireCode };

interface UploadProgressOpts {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

interface XhrSendOpts {
  url: string;
  formData: FormData;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

interface XhrSendResult {
  status: number;
  bodyText: string;
}

const KNOWN_WIRE_CODES: ReadonlySet<string> = new Set([
  "image_too_small",
  "image_too_large",
  "image_unsupported_format",
  "image_dimensions_exceeded",
  "image_count_exceeded",
  "image_corrupt",
  "image_duplicate_in_product",
  "image_storage_failed",
  "product_not_found",
  "image_not_found",
  "stale_write",
  "validation_failed",
  "forbidden",
]);

function coerceWireCode(raw: unknown): WireCode {
  if (typeof raw === "string" && KNOWN_WIRE_CODES.has(raw)) {
    return raw as WireCode;
  }
  return "image_storage_failed";
}

function sendMultipart(opts: XhrSendOpts): Promise<XhrSendResult> {
  return new Promise<XhrSendResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", opts.url, true);

    if (opts.onProgress) {
      const cb = opts.onProgress;
      xhr.upload.onprogress = (ev: ProgressEvent) => {
        if (!ev.lengthComputable || ev.total <= 0) return;
        const percent = Math.min(
          100,
          Math.max(0, Math.floor((ev.loaded / ev.total) * 100)),
        );
        cb(percent);
      };
    }

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        xhr.abort();
      } catch {
        // ignore — XHR may already be done
      }
      reject(new Error("aborted"));
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        // Already aborted — reject synchronously without sending.
        reject(new Error("aborted"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    xhr.onload = () => {
      if (aborted) return;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve({ status: xhr.status, bodyText: xhr.responseText ?? "" });
    };
    xhr.onerror = () => {
      if (aborted) return;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      reject(new Error("network_error"));
    };
    xhr.ontimeout = () => {
      if (aborted) return;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      reject(new Error("timeout"));
    };

    xhr.send(opts.formData);
  });
}

function parseSuccessImage(bodyText: string): ImageRow | null {
  try {
    const parsed = JSON.parse(bodyText) as { image?: ImageRow };
    if (parsed.image && typeof parsed.image === "object") {
      return parsed.image;
    }
    return null;
  } catch {
    return null;
  }
}

interface ErrorBody {
  code: WireCode;
  existingImageId?: string;
}

function parseErrorBody(bodyText: string): ErrorBody {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { code?: unknown };
      existingImageId?: unknown;
    };
    const code = coerceWireCode(parsed?.error?.code);
    const out: ErrorBody = { code };
    if (typeof parsed.existingImageId === "string") {
      out.existingImageId = parsed.existingImageId;
    }
    return out;
  } catch {
    return { code: "image_storage_failed" };
  }
}

export async function uploadProductImage(
  file: File,
  meta: {
    productId: string;
    expectedUpdatedAt: string;
    position?: number;
    altText?: { en?: string; ar?: string };
  },
  opts?: UploadProgressOpts,
): Promise<UploadResult> {
  const formData = new FormData();
  formData.append("image", file);
  const metaPayload: Record<string, unknown> = {
    productId: meta.productId,
    expectedUpdatedAt: meta.expectedUpdatedAt,
  };
  if (meta.position !== undefined) metaPayload.position = meta.position;
  if (meta.altText !== undefined) metaPayload.altText = meta.altText;
  formData.append("metadata", JSON.stringify(metaPayload));

  const { status, bodyText } = await sendMultipart({
    url: "/api/admin/images/upload",
    formData,
    ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });

  if (status === 200) {
    const image = parseSuccessImage(bodyText);
    if (image) return { ok: true, image };
    return { ok: false, code: "image_storage_failed" };
  }
  const err = parseErrorBody(bodyText);
  if (err.existingImageId !== undefined) {
    return {
      ok: false,
      code: err.code,
      existingImageId: err.existingImageId,
    };
  }
  return { ok: false, code: err.code };
}

export async function replaceProductImage(
  file: File,
  meta: { imageId: string; expectedUpdatedAt: string },
  opts?: UploadProgressOpts,
): Promise<ReplaceResult> {
  const formData = new FormData();
  formData.append("image", file);
  // confirm: true is hardcoded, never accepted from caller — the
  // server's Zod has z.literal(true); this is belt-and-braces.
  formData.append(
    "metadata",
    JSON.stringify({
      imageId: meta.imageId,
      expectedUpdatedAt: meta.expectedUpdatedAt,
      confirm: true,
    }),
  );

  const { status, bodyText } = await sendMultipart({
    url: "/api/admin/images/replace",
    formData,
    ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });

  if (status === 200) {
    const image = parseSuccessImage(bodyText);
    if (image) return { ok: true, image };
    return { ok: false, code: "image_storage_failed" };
  }
  const err = parseErrorBody(bodyText);
  return { ok: false, code: err.code };
}
