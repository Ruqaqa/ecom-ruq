/**
 * `listProductImages` — admin product image read (chunk 1a.7.1).
 *
 * Read service. No audit, no advisory lock, no role gate (the transport
 * gates to owner+staff). Defense-in-depth: assert role is in
 * {owner, staff} since this is admin-only data — bytes are NOT served
 * publicly in 1a.7.1; only the admin UI surfaces the derivative ledger.
 *
 * Tenant-scoped via the request context (`tenant.id`); a malicious
 * caller cannot pass a foreign tenant id since the service signature
 * takes a `{ id }` projection from the verified context.
 *
 * Sort order is `position ASC, id ASC` so cover (position 0) leads
 * deterministically. Tied positions are vanishingly rare (only during
 * the brief mid-cascade window in deleteProductImage) but stable
 * ordering keeps test fixtures comparable.
 */
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { productImages } from "@/server/db/schema/catalog";
import type { Tx } from "@/server/db";
import type { Role } from "@/server/tenant/context";

export interface ListProductImagesTenantInfo {
  id: string;
}

export const ListProductImagesInputSchema = z
  .object({
    productId: z.string().uuid(),
  })
  .strict();

export type ListProductImagesInput = z.input<
  typeof ListProductImagesInputSchema
>;

export interface ListProductImagesResult {
  productId: string;
  images: Array<{
    id: string;
    position: number;
    version: number;
    fingerprintSha256: string;
    storageKey: string;
    originalFormat: string;
    originalWidth: number;
    originalHeight: number;
    originalBytes: number;
    derivatives: import("@/server/db/schema/_types").ImageDerivative[];
    altText: { en?: string; ar?: string } | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
}

export async function listProductImages(
  tx: Tx,
  tenant: ListProductImagesTenantInfo,
  role: Role,
  input: ListProductImagesInput,
): Promise<ListProductImagesResult> {
  // Defense-in-depth role gate. The transport's requireRole is the
  // primary check; reaching here with a non-admin role is a wiring
  // bug and we surface it loudly (mirrors update-product.ts:95).
  if (role !== "owner" && role !== "staff") {
    throw new Error("listProductImages: role not permitted");
  }
  const parsed = ListProductImagesInputSchema.parse(input);

  const rows = await tx
    .select({
      id: productImages.id,
      position: productImages.position,
      version: productImages.version,
      fingerprintSha256: productImages.fingerprintSha256,
      storageKey: productImages.storageKey,
      originalFormat: productImages.originalFormat,
      originalWidth: productImages.originalWidth,
      originalHeight: productImages.originalHeight,
      originalBytes: productImages.originalBytes,
      derivatives: productImages.derivatives,
      altText: productImages.altText,
      createdAt: productImages.createdAt,
      updatedAt: productImages.updatedAt,
    })
    .from(productImages)
    .where(
      and(
        eq(productImages.tenantId, tenant.id),
        eq(productImages.productId, parsed.productId),
      ),
    )
    .orderBy(asc(productImages.position), asc(productImages.id));

  return {
    productId: parsed.productId,
    images: rows.map((r) => ({
      id: r.id,
      position: r.position,
      version: r.version,
      fingerprintSha256: r.fingerprintSha256,
      storageKey: r.storageKey,
      originalFormat: r.originalFormat,
      originalWidth: r.originalWidth,
      originalHeight: r.originalHeight,
      originalBytes: r.originalBytes,
      derivatives: r.derivatives,
      altText: (r.altText as { en?: string; ar?: string } | null) ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  };
}
