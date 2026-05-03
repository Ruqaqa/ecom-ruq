/**
 * `POST /api/admin/images/upload` — image upload route handler
 * (chunk 1a.7.1 Block 5b).
 *
 * Multipart body: { image (file part), metadata (JSON part with
 * productId/expectedUpdatedAt/position?/altText?) }.
 *
 * Order of operations (load-bearing):
 *   1. Body cap pre-parse (15 MB Content-Length).
 *   2. Resolve tenant from Host.
 *   3. Resolve identity. Anonymous + customer → 403 forbidden.
 *   4. Read multipart body.
 *   5. Defense-in-depth post-read body cap.
 *   6. Validate metadata via Zod.
 *   7. runWithAudit({ operation: 'images.upload', ... }) → invoke
 *      uploadProductImage service inside the audited tx.
 *   8. Wire-shape the response or the error.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolveTenant } from "@/server/tenant";
import { resolveRequestIdentity } from "@/server/auth/resolve-request-identity";
import { resolveMembership } from "@/server/auth/membership";
import { appDb } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { runWithAudit } from "@/server/audit/run-with-audit";
import { localizedTextPartial } from "@/lib/i18n/localized";
import {
  uploadProductImage,
} from "@/server/services/images/upload-product-image";
import {
  MAX_IMAGE_UPLOAD_BYTES,
  assertSameOriginMutation,
  classifyAuditCode,
  errorToWire,
  failureInputFromZod,
  jsonError,
  jsonOk,
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UploadMetadataSchema = z
  .object({
    productId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    position: z.number().int().nonnegative().optional(),
    altText: localizedTextPartial({ max: 200 }).optional(),
  })
  .strict();

function hostFromRequest(req: Request): string | null {
  try {
    return new URL(req.url).host.toLowerCase();
  } catch {
    return null;
  }
}

async function resolveAdminContext(req: Request): Promise<
  | { kind: "ok"; tenantId: string; userId: string; tokenId: string | null; role: "owner" | "staff" }
  | { kind: "error"; status: number; body: { error: { code: string } } }
> {
  const host = hostFromRequest(req);
  const tenant = await resolveTenant(host);
  if (!tenant) {
    return { kind: "error", status: 404, body: { error: { code: "not_found" } } };
  }
  const identity = await resolveRequestIdentity(req.headers, tenant);
  if (identity.type === "anonymous") {
    return { kind: "error", status: 403, body: { error: { code: "forbidden" } } };
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
    return { kind: "error", status: 403, body: { error: { code: "forbidden" } } };
  }
  return { kind: "ok", tenantId: tenant.id, userId: identity.userId, tokenId, role };
}

export async function POST(req: Request): Promise<Response> {
  // 0. Same-origin guard (CSRF). Cookie-authed mutations must come
  // from our origin; bearer-authed PAT calls fall through.
  const csrf = assertSameOriginMutation(req);
  if (csrf) return csrf;

  // 1. Pre-parse body cap.
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > MAX_IMAGE_UPLOAD_BYTES) {
    return jsonError(413, { error: { code: "image_too_large" } });
  }

  // 2 + 3. Tenant + identity + role gate.
  const ctxResult = await resolveAdminContext(req);
  if (ctxResult.kind === "error") {
    return jsonError(ctxResult.status, ctxResult.body);
  }
  const { tenantId, userId, tokenId, role } = ctxResult;

  // 4. Read multipart body.
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return jsonError(400, { error: { code: "validation_failed" } });
  }

  const filePart = formData.get("image");
  const metaPart = formData.get("metadata");
  if (!(filePart instanceof File) || typeof metaPart !== "string") {
    return jsonError(400, { error: { code: "validation_failed" } });
  }

  // 5. Post-read body cap.
  if (filePart.size > MAX_IMAGE_UPLOAD_BYTES) {
    return jsonError(413, { error: { code: "image_too_large" } });
  }

  // 6. Validate metadata.
  let parsedMetadata: z.infer<typeof UploadMetadataSchema>;
  try {
    const json = JSON.parse(metaPart);
    parsedMetadata = UploadMetadataSchema.parse(json);
  } catch {
    return jsonError(400, { error: { code: "validation_failed" } });
  }

  let fileBuffer: Buffer;
  try {
    const ab = await filePart.arrayBuffer();
    fileBuffer = Buffer.from(ab);
  } catch {
    return jsonError(400, { error: { code: "validation_failed" } });
  }
  if (fileBuffer.length > MAX_IMAGE_UPLOAD_BYTES) {
    return jsonError(413, { error: { code: "image_too_large" } });
  }

  if (!appDb) {
    return jsonError(500, { error: { code: "image_storage_failed" } });
  }

  const correlationId = randomUUID();
  const authedCtx = buildAuthedTenantContext(
    { id: tenantId },
    { userId, actorType: "user", tokenId, role },
  );

  // 7. runWithAudit + service invocation.
  try {
    const result = await runWithAudit({
      db: appDb,
      authedCtx,
      tenantId,
      operation: "images.upload",
      actor: { actorType: "user", actorId: userId, tokenId },
      correlationId,
      successInput: {
        productId: parsedMetadata.productId,
        position: parsedMetadata.position,
      },
      onFailure: (err) => ({
        errorCode: classifyAuditCode(err),
        failureInput: failureInputFromZod(err),
      }),
      work: async (tx) => {
        const r = await uploadProductImage(
          tx,
          { id: tenantId },
          role,
          {
            productId: parsedMetadata.productId,
            expectedUpdatedAt: parsedMetadata.expectedUpdatedAt,
            bytes: fileBuffer.toString("base64"),
            ...(parsedMetadata.position !== undefined
              ? { position: parsedMetadata.position }
              : {}),
            ...(parsedMetadata.altText !== undefined
              ? { altText: parsedMetadata.altText }
              : {}),
          },
        );
        return { result: r, after: r.after };
      },
    });
    return jsonOk({ ok: true, image: result.image });
  } catch (err) {
    const wire = errorToWire(err);
    return jsonError(wire.status, wire.body);
  }
}
