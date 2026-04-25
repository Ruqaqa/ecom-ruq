/**
 * `getProduct` — single-row read used by the admin edit RSC page (chunk
 * 1a.2).
 *
 * Contract:
 *   - Tenant-scoped SELECT under withTenant.
 *   - WHERE id, tenant_id, deleted_at IS NULL.
 *   - Returns null on no row (caller maps to notFound() / 404).
 *   - Role-gated SELECT column list AND output schema. Owner/staff see
 *     cost_price_minor; everyone else does not — Tier-B never crosses
 *     the wire even if a downstream caller widens the role gate.
 */
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { products } from "@/server/db/schema/catalog";
import {
  ProductOwnerSchema,
  ProductPublicSchema,
  type ProductOwner,
  type ProductPublic,
} from "./create-product";
import type { Tx } from "@/server/db";
import type { Role } from "@/server/tenant/context";

export interface GetProductTenantInfo {
  id: string;
}

export const GetProductInputSchema = z.object({
  id: z.string().uuid(),
});
export type GetProductInput = z.input<typeof GetProductInputSchema>;

export async function getProduct(
  tx: Tx,
  tenant: GetProductTenantInfo,
  role: Role,
  input: GetProductInput,
): Promise<ProductOwner | ProductPublic | null> {
  const parsed = GetProductInputSchema.parse(input);

  // Cost-price is owner-only for reads (per consolidated brief §A.3 —
  // operator-only per prd §6.5). Staff sees the public shape; owner
  // sees ProductOwner with costPriceMinor.
  const ownerRole = role === "owner";
  const baseSelect = {
    id: products.id,
    slug: products.slug,
    name: products.name,
    description: products.description,
    status: products.status,
    categoryId: products.categoryId,
    createdAt: products.createdAt,
    updatedAt: products.updatedAt,
  };
  const selectCols = ownerRole
    ? { ...baseSelect, costPriceMinor: products.costPriceMinor }
    : baseSelect;

  const rows = await tx
    .select(selectCols)
    .from(products)
    .where(
      and(
        eq(products.id, parsed.id),
        eq(products.tenantId, tenant.id),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (ownerRole) {
    return ProductOwnerSchema.parse(row);
  }
  return ProductPublicSchema.parse(row);
}
