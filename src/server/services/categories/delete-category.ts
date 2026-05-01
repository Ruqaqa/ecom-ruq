/**
 * `deleteCategory` — admin category soft-delete with cascade (chunk 1a.4.3).
 *
 * Mirrors `deleteProduct` plus category-specific cascade:
 *   1. Per-tenant `pg_advisory_xact_lock('categories_tree:' || tenantId)`
 *      taken first so cascade and concurrent re-parents serialize. Same
 *      lock `updateCategory` takes — without it a concurrent re-parent
 *      could leak a descendant out from under the walk.
 *   2. SELECT live target (NOT_FOUND if missing — IDOR-safe shape:
 *      cross-tenant id and phantom UUID look identical to the caller).
 *   3. BFS-walk LIVE descendants (bounded by MAX_TREE_DEPTH). Already-
 *      removed descendants are NOT touched — their earlier `deleted_at`
 *      stays intact so their recovery window is preserved.
 *   4. UPDATE target row with OCC predicate. date_trunc('milliseconds')
 *      reuses the OCC pattern from update-product / update-category.
 *   5. UPDATE descendant rows in one statement WHERE id IN (...) AND
 *      deleted_at IS NULL.
 *   6. `product_categories` join rows are PRESERVED on soft-delete — the
 *      link survives so restore is a clean reversal. Only hard-purge
 *      cascades the join (via the existing FK ON DELETE CASCADE).
 *
 * Returns `{ before, after, cascadedIds }`. `cascadedIds` carries the
 * target id plus every live descendant that flipped on this call —
 * forensically useful in audit when reconstructing the blast radius.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { categories } from "@/server/db/schema/catalog";
import { CategorySchema, type Category } from "./create-category";
import { MAX_TREE_DEPTH } from "./validate-category-tree";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import { StaleWriteError } from "@/server/audit/error-codes";

export interface DeleteCategoryTenantInfo {
  id: string;
}

export const DeleteCategoryInputSchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime(),
  // `z.literal(true)` rejects both absence and `false` per CLAUDE.md §6.
  confirm: z.literal(true),
});
export type DeleteCategoryInput = z.input<typeof DeleteCategoryInputSchema>;

export interface DeleteCategoryResult {
  /** Pre-delete target snapshot (deletedAt null). For audit `before`. */
  before: Category;
  /** Post-delete target snapshot (deletedAt populated). For audit `after`. */
  after: Category;
  /**
   * Target id plus every LIVE descendant that flipped on this call.
   * Already-removed descendants are not included (their earlier
   * `deleted_at` is preserved). Order is target-first, then descendant
   * order from BFS.
   */
  cascadedIds: string[];
}

async function selectLiveTarget(tx: Tx, tenantId: string, id: string) {
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
    .where(
      and(
        eq(categories.id, id),
        eq(categories.tenantId, tenantId),
        isNull(categories.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function liveDescendantIds(
  tx: Tx,
  tenantId: string,
  rootId: string,
): Promise<string[]> {
  const collected: string[] = [];
  let frontier: string[] = [rootId];
  for (let level = 0; level < MAX_TREE_DEPTH; level++) {
    const rows = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, tenantId),
          isNull(categories.deletedAt),
          inArray(categories.parentId, frontier),
        ),
      );
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    collected.push(...ids);
    frontier = ids;
  }
  return collected;
}

async function rowDepth(
  tx: Tx,
  tenantId: string,
  parentId: string | null,
): Promise<number> {
  if (parentId === null) return 1;
  let cur: string | null = parentId;
  let depth = 1;
  for (let i = 0; i <= MAX_TREE_DEPTH; i++) {
    if (cur === null) return depth;
    const rows: Array<{ parentId: string | null }> = await tx
      .select({ parentId: categories.parentId })
      .from(categories)
      .where(and(eq(categories.id, cur), eq(categories.tenantId, tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) return depth;
    depth += 1;
    cur = row.parentId;
  }
  return Math.min(depth, MAX_TREE_DEPTH);
}

export async function deleteCategory(
  tx: Tx,
  tenant: DeleteCategoryTenantInfo,
  role: Role,
  input: DeleteCategoryInput,
): Promise<DeleteCategoryResult> {
  if (!isWriteRole(role)) {
    throw new Error("deleteCategory: role not permitted");
  }
  const parsed = DeleteCategoryInputSchema.parse(input);

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('categories_tree:' || ${tenant.id}))`,
  );

  const beforeRow = await selectLiveTarget(tx, tenant.id, parsed.id);
  if (!beforeRow) {
    throw new TRPCError({ code: "NOT_FOUND", message: "category not found" });
  }
  const depth = await rowDepth(tx, tenant.id, beforeRow.parentId);
  const beforeParsed = CategorySchema.parse({ ...beforeRow, depth });

  const descIds = await liveDescendantIds(tx, tenant.id, parsed.id);

  const targetUpdated = await tx
    .update(categories)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(categories.id, parsed.id),
        eq(categories.tenantId, tenant.id),
        isNull(categories.deletedAt),
        sql`date_trunc('milliseconds', ${categories.updatedAt}) = date_trunc('milliseconds', ${parsed.expectedUpdatedAt}::timestamptz)`,
      ),
    )
    .returning();

  if (targetUpdated.length === 0) {
    const probe = await tx
      .select({ updatedAt: categories.updatedAt })
      .from(categories)
      .where(
        and(
          eq(categories.id, parsed.id),
          eq(categories.tenantId, tenant.id),
          isNull(categories.deletedAt),
        ),
      )
      .limit(1);
    if (probe.length === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: "category not found" });
    }
    throw new StaleWriteError("delete_category");
  }

  const cascadedDescIds: string[] = [];
  if (descIds.length > 0) {
    const descUpdated = await tx
      .update(categories)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(categories.tenantId, tenant.id),
          inArray(categories.id, descIds),
          isNull(categories.deletedAt),
        ),
      )
      .returning({ id: categories.id });
    for (const r of descUpdated) cascadedDescIds.push(r.id);
  }

  const afterParsed = CategorySchema.parse({ ...targetUpdated[0]!, depth });
  return {
    before: beforeParsed,
    after: afterParsed,
    cascadedIds: [parsed.id, ...cascadedDescIds],
  };
}
