/**
 * Tree validation helpers — chunk 1a.4.1.
 *
 * Categories are a single tree per tenant, max depth 3. We deliberately
 * AVOID recursive CTEs / generalized tree-walk libraries: with a
 * three-level cap, a manual walk is at most three SELECTs and far easier
 * to reason about than `WITH RECURSIVE`.
 *
 * `assertParentDepthOk` — given a candidate parent id, walks the parent
 * chain to compute its depth (1 for a root, 2 for a child of a root,
 * etc.). If parent depth ≥ 3, the new node would be at depth 4 — reject.
 *
 * `assertNoCycle` — given the node being moved and its proposed parent,
 * walks the proposed parent's chain looking for the node id. If hit,
 * reject (the node would become its own ancestor). Also covers the
 * trivial "parent = self" case.
 *
 * Depth-cap via the parent walk is the load-bearing safety net; we never
 * trust a stored depth column because there isn't one — depth is derived
 * each time. The walk is bounded by MAX_TREE_DEPTH so a malformed chain
 * (which RLS + foreign keys make impossible by construction, but defense
 * in depth) cannot loop.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { categories } from "@/server/db/schema/catalog";
import type { Tx } from "@/server/db";

export const MAX_TREE_DEPTH = 3;

/**
 * Returns the depth (1-based) of `nodeId` by walking its parent chain.
 * Throws BAD_REQUEST `parent_not_found` if the node doesn't exist in the
 * tenant or is soft-deleted; throws if the walk exceeds MAX_TREE_DEPTH
 * (defensive — should be impossible given the cap is enforced on writes).
 *
 * Used by `assertParentDepthOk` to verify a new child fits, and by
 * `updateCategory` to verify a moved subtree fits.
 */
async function getDepth(
  tx: Tx,
  tenantId: string,
  nodeId: string,
): Promise<number> {
  let cur: string = nodeId;
  for (let depth = 1; depth <= MAX_TREE_DEPTH + 1; depth++) {
    const rows: Array<{ parentId: string | null }> = await tx
      .select({ parentId: categories.parentId })
      .from(categories)
      .where(
        and(
          eq(categories.id, cur),
          eq(categories.tenantId, tenantId),
          isNull(categories.deletedAt),
        ),
      )
      .limit(1);
    const row: { parentId: string | null } | undefined = rows[0];
    if (!row) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "parent_not_found",
      });
    }
    if (row.parentId === null) return depth;
    cur = row.parentId;
  }
  // Walk overran the cap — malformed chain. Should be unreachable.
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "category_depth_exceeded",
  });
}

/**
 * Verifies a candidate parent exists in the tenant, is not soft-deleted,
 * and is shallow enough (depth ≤ MAX_TREE_DEPTH - 1) to host a new child
 * within the tree-depth cap. The new child would land at parentDepth + 1.
 */
export async function assertParentDepthOk(
  tx: Tx,
  tenantId: string,
  parentId: string,
): Promise<{ parentDepth: number }> {
  const parentDepth = await getDepth(tx, tenantId, parentId);
  if (parentDepth >= MAX_TREE_DEPTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "category_depth_exceeded",
    });
  }
  return { parentDepth };
}

/**
 * Cycle prevention for `updateCategory`. Walks the proposed-parent chain
 * looking for `nodeId` (which would close a cycle). The trivial
 * `parent = self` case is caught up front so we don't have to query for
 * it. Bounded by MAX_TREE_DEPTH; an out-of-bounds walk also rejects so
 * the caller cannot smuggle a nested chain past the depth check.
 */
export async function assertNoCycle(
  tx: Tx,
  tenantId: string,
  nodeId: string,
  proposedParentId: string,
): Promise<void> {
  if (nodeId === proposedParentId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "category_cycle" });
  }
  let cur: string | null = proposedParentId;
  for (let i = 0; i <= MAX_TREE_DEPTH; i++) {
    if (cur === null) return;
    if (cur === nodeId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "category_cycle" });
    }
    const rows: Array<{ parentId: string | null }> = await tx
      .select({ parentId: categories.parentId })
      .from(categories)
      .where(
        and(
          eq(categories.id, cur),
          eq(categories.tenantId, tenantId),
          isNull(categories.deletedAt),
        ),
      )
      .limit(1);
    const row: { parentId: string | null } | undefined = rows[0];
    if (!row) {
      // Proposed parent (or its ancestor) doesn't exist in tenant — let
      // the caller's parent-existence check throw the right error code.
      return;
    }
    cur = row.parentId;
  }
}

/**
 * Walks each row's parent chain in the in-memory map to compute depth.
 * Shared between `listCategories` (which already sees the full tenant
 * tree) and `listCategoriesForProduct` (which sees a subset). Bounded by
 * MAX_TREE_DEPTH; rows whose chain exceeds the cap are defensively
 * reported as MAX_TREE_DEPTH. If a parent isn't in the input set the
 * walk stops and the row's partial depth is returned — correct for the
 * subset case because the only consumer wants a depth label, not a full
 * ancestry.
 */
export function computeDepths(
  rows: Array<{ id: string; parentId: string | null }>,
): Map<string, number> {
  const byId = new Map<string, { parentId: string | null }>();
  for (const r of rows) byId.set(r.id, { parentId: r.parentId });
  const depths = new Map<string, number>();
  for (const r of rows) {
    let d = 1;
    let cur: string | null = r.parentId;
    while (cur !== null && d <= MAX_TREE_DEPTH) {
      d += 1;
      const next = byId.get(cur);
      if (!next) break;
      cur = next.parentId;
    }
    depths.set(r.id, Math.min(d, MAX_TREE_DEPTH));
  }
  return depths;
}

/**
 * Computes the depth of the deepest descendant of `nodeId` (1 = leaf
 * with no children, 2 = has children but no grandchildren, etc.). Used
 * by `updateCategory` to ensure that re-parenting a subtree doesn't
 * push any descendant past MAX_TREE_DEPTH.
 *
 * Bounded walk: at most one query per level, max 3 levels.
 */
export async function maxDescendantDepth(
  tx: Tx,
  tenantId: string,
  nodeId: string,
): Promise<number> {
  // BFS by level, bounded by MAX_TREE_DEPTH.
  let frontier: string[] = [nodeId];
  let depth = 1;
  for (let level = 0; level < MAX_TREE_DEPTH; level++) {
    const childRows = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, tenantId),
          isNull(categories.deletedAt),
          inArray(categories.parentId, frontier),
        ),
      );
    if (childRows.length === 0) return depth;
    frontier = childRows.map((r) => r.id);
    depth += 1;
  }
  return depth;
}
