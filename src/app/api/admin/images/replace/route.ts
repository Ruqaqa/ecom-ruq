/**
 * `POST /api/admin/images/replace` — image replace route handler
 * (chunk 1a.7.1 Block 5b).
 *
 * Multipart body: { image (file part), metadata (JSON with imageId,
 * expectedUpdatedAt, confirm:true) }.
 *
 * Mirrors the upload route, but invokes `replaceProductImage` and
 * carries `confirm:true` in the validated metadata. `confirm:false` or
 * missing → 400 validation_failed (Zod literal).
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolveTenant } from "@/server/tenant";
import { resolveRequestIdentity } from "@/server/auth/resolve-request-identity";
import { resolveMembership } from "@/server/auth/membership";
import { appDb } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { runWithAudit } from "@/server/audit/run-with-audit";
import { replaceProductImage } from "@/server/services/images/replace-product-image";
import {
  MAX_IMAGE_UPLOAD_BYTES,
  classifyAuditCode,
  errorToWire,
  failureInputFromZod,
  jsonError,
  jsonOk,
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ReplaceMetadataSchema = z
  .object({
    imageId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    confirm: z.literal(true),
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
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > MAX_IMAGE_UPLOAD_BYTES) {
    return jsonError(413, { error: { code: "image_too_large" } });
  }

  const ctxResult = await resolveAdminContext(req);
  if (ctxResult.kind === "error") {
    return jsonError(ctxResult.status, ctxResult.body);
  }
  const { tenantId, userId, tokenId, role } = ctxResult;

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

  if (filePart.size > MAX_IMAGE_UPLOAD_BYTES) {
    return jsonError(413, { error: { code: "image_too_large" } });
  }

  let parsedMetadata: z.infer<typeof ReplaceMetadataSchema>;
  try {
    const json = JSON.parse(metaPart);
    parsedMetadata = ReplaceMetadataSchema.parse(json);
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

  try {
    const result = await runWithAudit({
      db: appDb,
      authedCtx,
      tenantId,
      operation: "images.replace",
      actor: { actorType: "user", actorId: userId, tokenId },
      correlationId,
      successInput: { imageId: parsedMetadata.imageId },
      onFailure: (err) => ({
        errorCode: classifyAuditCode(err),
        failureInput: failureInputFromZod(err),
      }),
      work: async (tx) => {
        const r = await replaceProductImage(
          tx,
          { id: tenantId },
          role,
          {
            imageId: parsedMetadata.imageId,
            expectedUpdatedAt: parsedMetadata.expectedUpdatedAt,
            bytes: fileBuffer.toString("base64"),
            confirm: true,
          },
        );
        return { result: r, after: r.after, before: r.before };
      },
    });
    return jsonOk({ ok: true, image: result.image });
  } catch (err) {
    const wire = errorToWire(err);
    return jsonError(wire.status, wire.body);
  }
}
