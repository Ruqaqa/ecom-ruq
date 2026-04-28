/**
 * `listCategories` — admin category read (chunk 1a.4.1).
 *
 * Returns a flat list. Each item carries `parentId` and computed `depth`
 * (1 for roots, ≤ 3 by invariant). Bounded tree (depth ≤ 3 means a single
 * tenant cannot reasonably hold more than a few hundred categories), so
 * NO pagination — the whole tree fits in one response.
 *
 * Sort:
 *   includeDeleted=false (default) — parent_id NULLS FIRST, then position
 *   ASC, then name->>(default_locale) ASC, then id ASC.
 *
 *   includeDeleted=true — soft-deleted rows first, ordered by deleted_at
 *   DESC (most-recently-removed at the top), then live rows in the live
 *   sort. Mirrors the products "Show removed" UX.
 *
 * Depth computation: the flat output stamps depth per-row by walking each
 * parent chain locally (no recursive CTE — bounded by MAX_TREE_DEPTH=3).
 * Cheaper than re-querying once depth is in-memory.
 */
import { z } from "zod";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { categories } from "@/server/db/schema/catalog";
import { CategorySchema, type Category } from "./create-category";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import { computeDepths } from "./validate-category-tree";

export interface ListCategoriesTenantInfo {
  id: string;
  defaultLocale: "en" | "ar";
}

export const ListCategoriesInputSchema = z.object({
  includeDeleted: z.boolean().default(false),
});
export type ListCategoriesInput = z.input<typeof ListCategoriesInputSchema>;

export const ListCategoriesOutputSchema = z.object({
  items: z.array(CategorySchema),
});
export type ListCategoriesOutput = z.infer<typeof ListCategoriesOutputSchema>;

const arCollator = new Intl.Collator("ar");

export async function listCategories(
  tx: Tx,
  tenant: ListCategoriesTenantInfo,
  role: Role,
  input: ListCategoriesInput,
): Promise<ListCategoriesOutput> {
  if (!isWriteRole(role)) {
    throw new Error("listCategories: role not permitted");
  }
  const parsed = ListCategoriesInputSchema.parse(input);

  const filters = [eq(categories.tenantId, tenant.id)];
  if (!parsed.includeDeleted) {
    filters.push(isNull(categories.deletedAt));
  }

  const orderBy = parsed.includeDeleted
    ? [
        // deleted rows ahead of live (FALSE < TRUE in pg).
        sql`(${categories.deletedAt} IS NULL) ASC`,
        sql`${categories.deletedAt} DESC NULLS LAST`,
        sql`${categories.parentId} ASC NULLS FIRST`,
        asc(categories.position),
        sql`${categories.name}->>'en' ASC`,
        asc(categories.id),
      ]
    : [
        sql`${categories.parentId} ASC NULLS FIRST`,
        asc(categories.position),
        sql`${categories.name}->>'en' ASC`,
        asc(categories.id),
      ];

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
    .from(categories)
    .where(and(...filters))
    .orderBy(...orderBy);

  // Default-locale-aware secondary sort. The SQL ORDER BY uses 'en' as
  // the textual key for stability (jsonb extraction); when the tenant's
  // default locale is 'ar' we re-sort the live bucket by the Arabic
  // name in JS to match operator expectations. Bounded by the tenant's
  // total category count (small).
  const defaultLocale = tenant.defaultLocale ?? "en";
  let ordered = rows;
  if (defaultLocale === "ar") {
    ordered = [...rows].sort((a, b) => {
      // Sort key parity with SQL: deleted bucket first, parent NULLS FIRST,
      // position, then ar name, then id.
      const aDel = a.deletedAt ? 1 : 0;
      const bDel = b.deletedAt ? 1 : 0;
      if (aDel !== bDel) return aDel - bDel; // FALSE first when not includeDeleted
      // For deleted rows, more-recent deletedAt first.
      if (a.deletedAt && b.deletedAt) {
        const dt = b.deletedAt.getTime() - a.deletedAt.getTime();
        if (dt !== 0) return dt;
      }
      // parentId NULLS FIRST.
      if (a.parentId === null && b.parentId !== null) return -1;
      if (a.parentId !== null && b.parentId === null) return 1;
      // position ascending.
      if (a.position !== b.position) return a.position - b.position;
      const aName = (a.name as { ar?: string }).ar ?? "";
      const bName = (b.name as { ar?: string }).ar ?? "";
      const cmp = arCollator.compare(aName, bName);
      if (cmp !== 0) return cmp;
      return a.id.localeCompare(b.id);
    });
  }

  const depths = computeDepths(
    ordered.map((r) => ({ id: r.id, parentId: r.parentId })),
  );

  const items: Category[] = ordered.map((row) =>
    CategorySchema.parse({ ...row, depth: depths.get(row.id) ?? 1 }),
  );
  return { items };
}
