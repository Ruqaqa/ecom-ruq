/**
 * `listCategoriesForProduct` — admin read of a product's currently-linked
 * categories (chunk 1a.4.2).
 *
 * Used by the admin product-edit RSC to prefill chips on the multi-pick
 * picker. Output mirrors `listCategories`: same flat `Category` shape
 * with `depth` stamped, wrapped in `{ items }`.
 *
 * Existence-leak guard:
 *   - cross-tenant productId, missing-from-tenant productId, malformed
 *     uuid, soft-deleted product → all return `{ items: [] }`. Never
 *     surface "this product exists" via a different shape.
 *
 * Tenant scoping:
 *   - join filters by `pc.tenant_id` AND `c.tenant_id` (both required —
 *     the composite same-tenant FK is the data-layer guard, but the
 *     service still scopes explicitly so a future schema slip doesn't
 *     widen the read).
 *   - soft-deleted categories (`c.deleted_at IS NOT NULL`) are filtered
 *     out — the picker shows live-only.
 *
 * No pagination — depth-3 cap means a tenant has a few hundred
 * categories at most; a product is realistically linked to fewer than
 * thirty. The whole link set fits in one response.
 */
import { z } from "zod";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { categories, productCategories } from "@/server/db/schema/catalog";
import { CategorySchema, type Category } from "./create-category";
import { computeDepths } from "./validate-category-tree";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";

export interface ListForProductTenantInfo {
  id: string;
}

export const ListForProductInputSchema = z.object({
  productId: z.string().uuid(),
});
export type ListForProductInput = z.input<typeof ListForProductInputSchema>;

export const ListForProductOutputSchema = z.object({
  items: z.array(CategorySchema),
});
export type ListForProductOutput = z.infer<typeof ListForProductOutputSchema>;

export async function listCategoriesForProduct(
  tx: Tx,
  tenant: ListForProductTenantInfo,
  role: Role,
  input: ListForProductInput,
): Promise<ListForProductOutput> {
  if (!isWriteRole(role)) {
    throw new Error("listCategoriesForProduct: role not permitted");
  }
  const parsed = ListForProductInputSchema.parse(input);

  const rows = await tx
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      description: categories.description,
      parentId: categories.parentId,
      position: categories.position,
      createdAt: categories.createdAt,
      updatedAt: categories.updatedAt,
      deletedAt: categories.deletedAt,
    })
    .from(productCategories)
    .innerJoin(
      categories,
      and(
        eq(categories.id, productCategories.categoryId),
        eq(categories.tenantId, productCategories.tenantId),
      ),
    )
    .where(
      and(
        eq(productCategories.tenantId, tenant.id),
        eq(productCategories.productId, parsed.productId),
        isNull(categories.deletedAt),
      ),
    )
    .orderBy(
      sql`${categories.parentId} ASC NULLS FIRST`,
      asc(categories.position),
      sql`${categories.name}->>'en' ASC`,
      asc(categories.id),
    );

  const depths = computeDepths(
    rows.map((r) => ({ id: r.id, parentId: r.parentId })),
  );
  const items: Category[] = rows.map((row) =>
    CategorySchema.parse({ ...row, depth: depths.get(row.id) ?? 1 }),
  );
  return ListForProductOutputSchema.parse({ items });
}
