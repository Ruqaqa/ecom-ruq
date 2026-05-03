/**
 * `GET /api/admin/images/[imageId]/[size]/[format]` — admin-only
 * derivative byte delivery (chunk 1a.7.2 Block 1b).
 *
 * Order of operations (load-bearing):
 *   1. Zod-parse path params. Bad → 400 validation_failed.
 *      `original` is unaddressable — not in the size enum.
 *   2. Same-origin / Sec-Fetch-Site read guard.
 *   3. Resolve tenant + identity + role gate (owner+staff only).
 *   4. Tenant-scoped DB read of product_images by id.
 *   5. Ledger lookup for (size, format). Missing → 404 not_found.
 *   6. adapter.get(derivative.storageKey). Null → 404 not_found.
 *      StorageBackendError → 500 internal_error (Sentry-captured).
 *   7. Stream bytes back with strict Cache-Control + CSP headers.
 *
 * No audit row for reads. Mirrors `images.list` (read services don't
 * audit). Thin adapter call — no service-layer wrapping.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { resolveTenant } from "@/server/tenant";
import { resolveRequestIdentity } from "@/server/auth/resolve-request-identity";
import { resolveMembership } from "@/server/auth/membership";
import { appDb, withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { productImages } from "@/server/db/schema/catalog";
import {
  FORMAT_CONTENT_TYPE,
  type DerivativeFormat,
  type DerivativeSize,
} from "@/server/services/images/constants";
import type { ImageDerivative } from "@/server/db/schema/_types";
import { getStorageAdapter } from "@/server/storage";
import { StorageBackendError } from "@/server/storage/types";
import { captureMessage, summarizeErrorForObs } from "@/server/obs/sentry";
import { jsonError, assertSameOriginRead } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PathParamsSchema = z
  .object({
    imageId: z.string().uuid(),
    size: z.enum(["thumb", "card", "page", "zoom", "share"]),
    format: z.enum(["avif", "webp", "jpeg"]),
  })
  .strict();

function hostFromRequest(req: Request): string | null {
  try {
    return new URL(req.url).host.toLowerCase();
  } catch {
    return null;
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  vary: "Cookie",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; img-src 'self'; frame-ancestors 'none'",
};

export async function GET(
  req: Request,
  context: {
    params: Promise<{ imageId: string; size: string; format: string }>;
  },
): Promise<Response> {
  // 1. Zod-parse path params. Original is unaddressable (size enum).
  const rawParams = await context.params;
  let parsed: { imageId: string; size: DerivativeSize; format: DerivativeFormat };
  try {
    parsed = PathParamsSchema.parse(rawParams);
  } catch {
    return jsonError(400, { error: { code: "validation_failed" } });
  }

  // 2. Same-origin read guard.
  const csrf = assertSameOriginRead(req);
  if (csrf) return csrf;

  // 3. Tenant + identity + role gate.
  const host = hostFromRequest(req);
  const tenant = await resolveTenant(host);
  if (!tenant) {
    return jsonError(404, { error: { code: "not_found" } });
  }
  const identity = await resolveRequestIdentity(req.headers, tenant);
  if (identity.type === "anonymous") {
    return jsonError(403, { error: { code: "forbidden" } });
  }

  let role: "owner" | "staff" | "support" | "customer";
  let tokenId: string | null;
  if (identity.type === "bearer") {
    role = identity.effectiveRole;
    tokenId = identity.tokenId;
  } else {
    const membership = await resolveMembership(identity.userId, tenant.id);
    role = membership?.role ?? "customer";
    tokenId = null;
  }
  if (role !== "owner" && role !== "staff") {
    return jsonError(403, { error: { code: "forbidden" } });
  }

  if (!appDb) {
    return jsonError(500, { error: { code: "internal_error" } });
  }

  // 4. Tenant-scoped DB read.
  const authedCtx = buildAuthedTenantContext(
    { id: tenant.id },
    { userId: identity.userId, actorType: "user", tokenId, role },
  );
  let row: {
    id: string;
    derivatives: ImageDerivative[];
  } | null = null;
  try {
    row = await withTenant(appDb, authedCtx, async (tx) => {
      const rows = await tx
        .select({
          id: productImages.id,
          derivatives: productImages.derivatives,
        })
        .from(productImages)
        .where(
          and(
            eq(productImages.tenantId, tenant.id),
            eq(productImages.id, parsed.imageId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    });
  } catch (err) {
    captureMessage("admin_image_get_db_failed", {
      extra: { reason: summarizeErrorForObs(err) },
    });
    return jsonError(500, { error: { code: "internal_error" } });
  }
  if (!row) {
    return jsonError(404, { error: { code: "not_found" } });
  }

  // 5. Ledger lookup.
  const derivative = row.derivatives.find(
    (d) => d.size === parsed.size && d.format === parsed.format,
  );
  if (!derivative) {
    return jsonError(404, { error: { code: "not_found" } });
  }

  // 6. Storage fetch.
  const adapter = getStorageAdapter();
  let fetched: { bytes: Buffer; contentType: string } | null;
  try {
    fetched = await adapter.get(derivative.storageKey);
  } catch (err) {
    if (err instanceof StorageBackendError) {
      captureMessage("admin_image_get_storage_failed", {
        extra: {
          reason: err.opaqueCode,
          summary: summarizeErrorForObs(err),
        },
      });
      return jsonError(500, { error: { code: "internal_error" } });
    }
    captureMessage("admin_image_get_unknown_failed", {
      extra: { reason: summarizeErrorForObs(err) },
    });
    return jsonError(500, { error: { code: "internal_error" } });
  }
  if (!fetched) {
    return jsonError(404, { error: { code: "not_found" } });
  }

  // 7. Stream bytes back.
  const contentType = FORMAT_CONTENT_TYPE[parsed.format];
  // Buffer ↔ Response BodyInit: TS lib types don't accept Buffer/
  // Uint8Array directly here. Slice into a fresh ArrayBuffer view that
  // matches BodyInit.
  const ab = fetched.bytes.buffer.slice(
    fetched.bytes.byteOffset,
    fetched.bytes.byteOffset + fetched.bytes.byteLength,
  ) as ArrayBuffer;
  // Source of truth = bytes actually shipped, not the ledger value.
  // If the storage adapter ever returns bytes whose length disagrees
  // with the ledger (corruption, partial-write recovery, future
  // BunnyCDN representation swap), declaring one length and shipping
  // another is an HTTP protocol violation. Sourcing from the buffer
  // closes that gap.
  return new Response(ab, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": contentType,
      "content-length": String(fetched.bytes.byteLength),
    },
  });
}
