/**
 * Shared route-handler utilities for the byte-upload surfaces
 * (chunk 1a.7.1 Block 5b).
 *
 * Both POST handlers (upload, replace) follow the same envelope:
 *   1. Pre-parse Content-Length cap (15 MB).
 *   2. Resolve tenant from Host header.
 *   3. Resolve identity (session ∨ bearer ∨ anonymous).
 *   4. Reject anonymous and customer-role with 403 forbidden.
 *   5. Parse multipart body — `image` file part + `metadata` JSON part.
 *   6. Defense-in-depth post-read body cap.
 *   7. Invoke runWithAudit with the appropriate operation key.
 *   8. Wire-shape the response via codeToHttpStatus.
 *
 * Error wire shape: `{ error: { code: '<closed-set-code>' } }` plus
 * `{ existingImageId }` on duplicate-fingerprint conflict (operator UI
 * convenience). Closed-set codes mirror Block 4's TRPCError messages
 * so route handler responses match tRPC responses byte-for-byte.
 */
import { TRPCError } from "@trpc/server";
import { ZodError, type ZodIssue } from "zod";
import { findPgErrorRecord } from "@/server/db/pg-errors";
import { StaleWriteError } from "@/server/audit/error-codes";

export const MAX_IMAGE_UPLOAD_BYTES = 15 * 1024 * 1024;

export const NO_STORE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "content-type": "application/json",
};

/**
 * Same-origin guard for cookie-authed mutations. Returns null on accept,
 * a `Response` (403 forbidden) on reject. Bearer-authed (PAT) requests
 * fall through accept since bearer auth is server-trusted (no ambient
 * cookie attack vector).
 *
 * Policy:
 *   1. Host derivable from req.url? else reject.
 *   2. Origin header present? compare host. Mismatch / parse-error reject.
 *   3. Else Referer header present? compare host. Mismatch / parse-error reject.
 *   4. Else Authorization: Bearer ...? accept (PAT path).
 *   5. Else reject.
 */
export function assertSameOriginMutation(req: Request): Response | null {
  let host: string;
  try {
    host = new URL(req.url).host.toLowerCase();
  } catch {
    return jsonError(403, { error: { code: "forbidden" } });
  }
  if (!host) {
    return jsonError(403, { error: { code: "forbidden" } });
  }

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      if (originHost === host) return null;
      return jsonError(403, { error: { code: "forbidden" } });
    } catch {
      return jsonError(403, { error: { code: "forbidden" } });
    }
  }

  const referer = req.headers.get("referer");
  if (referer) {
    try {
      const refHost = new URL(referer).host.toLowerCase();
      if (refHost === host) return null;
      return jsonError(403, { error: { code: "forbidden" } });
    } catch {
      return jsonError(403, { error: { code: "forbidden" } });
    }
  }

  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  return jsonError(403, { error: { code: "forbidden" } });
}

/**
 * Same-origin guard for cookie-authed reads. Sec-Fetch-Site is the
 * primary signal in modern browsers; older browsers (and bearer-authed
 * programmatic clients) fall through to accept since the UUID
 * unguessability + admin auth gate is the defense.
 *
 * Reject only on Sec-Fetch-Site values that explicitly flag a cross-
 * site request: anything other than `same-origin` or `none`. The
 * bearer/PAT path is implicit — programmatic clients don't set
 * Sec-Fetch-Site, so they fall through this guard naturally; admin
 * auth + UUID unguessability are the defense for that channel.
 */
export function assertSameOriginRead(req: Request): Response | null {
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") {
    return jsonError(403, { error: { code: "forbidden" } });
  }
  return null;
}

export interface ErrorBody {
  error: { code: string };
  existingImageId?: string;
}

export function jsonError(
  status: number,
  body: ErrorBody,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: NO_STORE_HEADERS,
  });
}

export function jsonOk<T>(body: T): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: NO_STORE_HEADERS,
  });
}

/**
 * Translate a closed-set wire code → HTTP status. Mirrors the brief's
 * Block 5b acceptance table.
 */
export function codeToHttpStatus(code: string): number {
  switch (code) {
    case "image_too_small":
    case "image_too_large":
    case "image_unsupported_format":
    case "image_dimensions_exceeded":
    case "image_count_exceeded":
    case "image_corrupt":
    case "validation_failed":
      return 400;
    case "forbidden":
    case "unauthorized":
      return 403;
    case "image_not_found":
    case "product_not_found":
    case "variant_not_found":
    case "not_found":
      return 404;
    case "image_duplicate_in_product":
    case "stale_write":
    case "conflict":
      return 409;
    case "image_storage_failed":
    case "internal_error":
      return 500;
    default:
      return 500;
  }
}

/**
 * Translate any thrown error to a wire-shaped `(status, body)` pair.
 * Mirrors the route's `mapErrorToAuditCode` flow but emits the
 * closed-set wire codes the brief specifies.
 */
export function errorToWire(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof TRPCError) {
    const code = err.message;
    const body: ErrorBody = { error: { code } };
    if (
      code === "image_duplicate_in_product" &&
      err.cause &&
      typeof err.cause === "object" &&
      "existingImageId" in err.cause &&
      typeof (err.cause as { existingImageId?: unknown }).existingImageId === "string"
    ) {
      body.existingImageId = (err.cause as { existingImageId: string }).existingImageId;
    }
    return { status: codeToHttpStatus(code), body };
  }
  if (err instanceof StaleWriteError) {
    return { status: 409, body: { error: { code: "stale_write" } } };
  }
  if (err instanceof ZodError) {
    return { status: 400, body: { error: { code: "validation_failed" } } };
  }
  // pg conflict surfaces (race-loss): translate to internal_error
  // unless we recognize the constraint.
  const pg = findPgErrorRecord(err);
  if (pg?.code === "23505") {
    return {
      status: 409,
      body: { error: { code: "image_duplicate_in_product" } },
    };
  }
  return { status: 500, body: { error: { code: "image_storage_failed" } } };
}

/**
 * Translate the closed-set wire code → AuditErrorCode for the failure
 * audit row (mirrors the brief's classification table). Distinct from
 * `mapErrorToAuditCode` because this seam knows our specific closed-set
 * already. Falls back to `internal_error` for anything unrecognized.
 */
export function classifyAuditCode(
  err: unknown,
):
  | "validation_failed"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "stale_write"
  | "internal_error" {
  if (err instanceof StaleWriteError) return "stale_write";
  if (err instanceof TRPCError) {
    switch (err.code) {
      case "BAD_REQUEST":
        return "validation_failed";
      case "NOT_FOUND":
        return "not_found";
      case "UNAUTHORIZED":
      case "FORBIDDEN":
        return "forbidden";
      case "CONFLICT":
        return "conflict";
    }
  }
  if (err instanceof ZodError) return "validation_failed";
  const pg = findPgErrorRecord(err);
  if (pg?.code === "23505") return "conflict";
  return "internal_error";
}

/**
 * Produce a forensic-only failure-input shape. Mirrors `inputForFailure`
 * in audit/adapter-wrap. Field paths only — never raw caller-submitted
 * values, since the audit chain is PDPL-undeletable.
 */
export function failureInputFromZod(err: unknown): unknown {
  if (err instanceof ZodError) {
    const paths = (err.issues as ZodIssue[])
      .map((i) => (i.path ?? []).map(String).join("."))
      .filter((s) => s.length > 0);
    return { kind: "validation", failedPaths: paths };
  }
  return undefined;
}
