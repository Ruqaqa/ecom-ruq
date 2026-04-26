/**
 * `updateCategory` — admin category edit (chunk 1a.4.1).
 *
 * Mirrors `updateProduct`:
 *   1. No `withTenant` / no tx open — adapter owns the lifecycle.
 *   2. Sparse update; `key in input` triggers SET. Absent keys leave
 *      the column alone.
 *   3. OCC via `expectedUpdatedAt` with the date_trunc('milliseconds',…)
 *      pattern. Empty RETURNING → SELECT to disambiguate gone vs stale.
 *   4. Slug collision (pg 23505 on categories_tenant_slug_unique_live) →
 *      SlugTakenError. Live-only — collisions against soft-deleted rows
 *      pass through (the partial index doesn't catch them).
 *   5. Cycle prevention: parentId = self → category_cycle. Parent =
 *      descendant → category_cycle (assertNoCycle walks the chain).
 *   6. Depth check: re-parenting may not push descendants past
 *      MAX_TREE_DEPTH. Computed via maxDescendantDepth + parent depth.
 *   7. Parent in another tenant or soft-deleted → parent_not_found
 *      (BAD_REQUEST). Same shape as createCategory's parent guard.
 *
 * Returns `{ before, after }` — both full Category snapshots. Audit-wrap
 * (transport-side) records both.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { categories } from "@/server/db/schema/catalog";
import { localizedTextPartial } from "@/lib/i18n/localized";
import { slugSchema } from "@/lib/product-slug";
import {
  CategorySchema,
  type Category,
} from "./create-category";
import { extractPgUniqueViolation } from "./pg-error-helpers";
import {
  assertNoCycle,
  assertParentDepthOk,
  maxDescendantDepth,
  MAX_TREE_DEPTH,
} from "./validate-category-tree";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import { SlugTakenError, StaleWriteError } from "@/server/audit/error-codes";

export interface UpdateCategoryTenantInfo {
  id: string;
}

const EDITABLE_KEYS = [
  "slug",
  "name",
  "description",
  "parentId",
  "position",
] as const;

export const UpdateCategoryInputSchema = z
  .object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    slug: slugSchema.optional(),
    name: localizedTextPartial({ max: 256 }).optional(),
    description: localizedTextPartial({ max: 4096 }).optional(),
    // null = make root, absent = leave alone, uuid = re-parent.
    parentId: z.string().uuid().nullable().optional(),
    position: z.number().int().nonnegative().optional(),
  })
  .refine(
    (input) => EDITABLE_KEYS.some((k) => k in input),
    { message: "at least one editable field required" },
  );
export type UpdateCategoryInput = z.input<typeof UpdateCategoryInputSchema>;

export interface UpdateCategoryResult {
  /** Pre-update full Category snapshot. For audit `before`. */
  before: Category;
  /** Post-update full Category snapshot. For audit `after`. */
  after: Category;
}

async function selectCategoryOrNull(
  tx: Tx,
  tenantId: string,
  id: string,
  includeDeleted: boolean,
) {
  const filters = [
    eq(categories.id, id),
    eq(categories.tenantId, tenantId),
  ];
  if (!includeDeleted) filters.push(isNull(categories.deletedAt));
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
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Walks the parent chain to compute a depth, mirroring the helper in
 * validate-category-tree.ts. Used to stamp `depth` on returned rows.
 */
async function computeDepth(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<number> {
  let cur: string = id;
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
    if (!row) return MAX_TREE_DEPTH; // defensive — should not be reachable
    if (row.parentId === null) return depth;
    cur = row.parentId;
  }
  return MAX_TREE_DEPTH;
}

export async function updateCategory(
  tx: Tx,
  tenant: UpdateCategoryTenantInfo,
  role: Role,
  input: UpdateCategoryInput,
): Promise<UpdateCategoryResult> {
  if (!isWriteRole(role)) {
    throw new Error("updateCategory: role not permitted");
  }
  const parsed = UpdateCategoryInputSchema.parse(input);

  // Serialize concurrent tree mutations within this tenant. Without this
  // lock, two parallel re-parents in opposite directions (X→Y and Y→X)
  // each pass their cycle/depth pre-checks against pre-other snapshots
  // (READ COMMITTED) and both commit, leaving a cycle in the tree. The
  // OCC clause on expectedUpdatedAt only protects same-row collisions.
  // Mirrors the audit-chain advisory lock pattern.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('categories_tree:' || ${tenant.id}))`,
  );

  // 1. Pre-load the live row (parent guards need its current state).
  const beforeRow = await selectCategoryOrNull(tx, tenant.id, parsed.id, false);
  if (!beforeRow) {
    throw new TRPCError({ code: "NOT_FOUND", message: "category not found" });
  }
  const beforeDepth = await computeDepth(tx, tenant.id, beforeRow.id);
  const beforeParsed = CategorySchema.parse({
    ...beforeRow,
    depth: beforeDepth,
  });

  // 2. Tree-shape guards (only when parentId is in the patch and not null).
  const proposedParentId =
    "parentId" in parsed && parsed.parentId !== null && parsed.parentId !== undefined
      ? parsed.parentId
      : null;
  if (proposedParentId !== null) {
    if (proposedParentId === parsed.id) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "category_cycle",
      });
    }
    await assertNoCycle(tx, tenant.id, parsed.id, proposedParentId);
    const { parentDepth } = await assertParentDepthOk(
      tx,
      tenant.id,
      proposedParentId,
    );
    // Depth check across the entire moved subtree.
    const subtreeDepth = await maxDescendantDepth(tx, tenant.id, parsed.id);
    if (parentDepth + subtreeDepth > MAX_TREE_DEPTH) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "category_depth_exceeded",
      });
    }
  }

  // 3. Build the SET clause.
  const setClause: Record<string, unknown> = { updatedAt: sql`now()` };
  if ("slug" in parsed) setClause.slug = parsed.slug;
  if ("name" in parsed) {
    const next = {
      ...(beforeParsed.name as { en: string; ar: string }),
      ...(parsed.name ?? {}),
    };
    setClause.name = next;
  }
  if ("description" in parsed) {
    if (parsed.description === undefined || parsed.description === null) {
      setClause.description = null;
    } else {
      const existing = (beforeParsed.description ?? {}) as {
        en?: string;
        ar?: string;
      };
      setClause.description = { ...existing, ...parsed.description };
    }
  }
  if ("parentId" in parsed) setClause.parentId = parsed.parentId;
  if ("position" in parsed) setClause.position = parsed.position;

  // 4. UPDATE WHERE id, tenant_id, deleted_at IS NULL, OCC matches.
  let updatedRows;
  try {
    updatedRows = await tx
      .update(categories)
      .set(setClause)
      .where(
        and(
          eq(categories.id, parsed.id),
          eq(categories.tenantId, tenant.id),
          isNull(categories.deletedAt),
          sql`date_trunc('milliseconds', ${categories.updatedAt}) = date_trunc('milliseconds', ${parsed.expectedUpdatedAt}::timestamptz)`,
        ),
      )
      .returning();
  } catch (err) {
    if (
      extractPgUniqueViolation(err, "categories_tenant_slug_unique_live")
    ) {
      throw new SlugTakenError(err);
    }
    throw err;
  }

  if (updatedRows.length === 0) {
    // 5. Disambiguate: gone, or stale?
    const probeRows = await tx
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
    if (probeRows.length === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: "category not found" });
    }
    throw new StaleWriteError("update_category");
  }

  const updatedRow = updatedRows[0]!;
  const afterDepth = await computeDepth(tx, tenant.id, updatedRow.id);
  const afterParsed = CategorySchema.parse({ ...updatedRow, depth: afterDepth });
  return { before: beforeParsed, after: afterParsed };
}
