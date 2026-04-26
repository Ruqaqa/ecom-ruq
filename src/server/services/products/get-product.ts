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
import { isWriteRole, type Role } from "@/server/tenant/context";

export interface GetProductTenantInfo {
  id: string;
}

export const GetProductInputSchema = z.object({
  id: z.string().uuid(),
  // Admin "Show removed" detail view. Default false: a soft-deleted id
  // resolves to null (404 at the route). Owner/staff can opt-in to
  // fetch the deleted row for the restore UI.
  includeDeleted: z.boolean().default(false),
});
export type GetProductInput = z.input<typeof GetProductInputSchema>;

export async function getProduct(
  tx: Tx,
  tenant: GetProductTenantInfo,
  role: Role,
  input: GetProductInput,
): Promise<ProductOwner | ProductPublic | null> {
  const parsed = GetProductInputSchema.parse(input);
  // Defense-in-depth: only owner/staff may flip includeDeleted. Primary
  // gate is at the transport.
  if (parsed.includeDeleted && !isWriteRole(role)) {
    throw new Error("includeDeleted requires owner or staff role");
  }

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
    createdAt: products.createdAt,
    updatedAt: products.updatedAt,
    deletedAt: products.deletedAt,
  };
  const selectCols = ownerRole
    ? { ...baseSelect, costPriceMinor: products.costPriceMinor }
    : baseSelect;

  const whereFilters = [
    eq(products.id, parsed.id),
    eq(products.tenantId, tenant.id),
  ];
  if (!parsed.includeDeleted) {
    whereFilters.push(isNull(products.deletedAt));
  }

  const rows = await tx
    .select(selectCols)
    .from(products)
    .where(and(...whereFilters))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (ownerRole) {
    return ProductOwnerSchema.parse(row);
  }
  return ProductPublicSchema.parse(row);
}
