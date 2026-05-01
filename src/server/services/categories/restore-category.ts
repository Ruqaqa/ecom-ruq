/**
 * `restoreCategory` — admin category restore (chunk 1a.4.3).
 *
 * Single-row restore. Cascade-restore is NOT supported — the operator
 * must restore each removed row explicitly. Three category-specific
 * checks layered on top of the products restore pattern:
 *
 *   1. Per-tenant `pg_advisory_xact_lock('categories_tree:' || tenantId)`
 *      taken first so concurrent restore + re-parent + delete serialize.
 *   2. SELECT pre-restore row (NOT_FOUND if not removed — IDOR-safe shape).
 *   3. 30-day window check → `RestoreWindowExpiredError`.
 *   4. Parent-still-removed guard: if the row's `parent_id` is non-null
 *      and that parent's `deleted_at IS NOT NULL`, refuse with
 *      BAD_REQUEST `parent_still_removed`. The operator restores the
 *      parent first.
 *   5. Depth re-check: re-parents/moves on live ancestors while the row
 *      was removed could push it past depth 3. Walk live ancestry and
 *      reject `category_depth_exceeded` if so.
 *   6. UPDATE clears `deleted_at`. Slug collisions on the live partial
 *      unique index `categories_tenant_slug_unique_live` (a sibling took
 *      the slug while this row was removed) → `SlugTakenError`.
 *
 * No `expectedUpdatedAt` — soft-deleted rows aren't editable in the
 * default admin list, so an OCC token would be theatre. Concurrent
 * restore+restore on the same row is naturally idempotent.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { categories } from "@/server/db/schema/catalog";
import { CategorySchema, type Category } from "./create-category";
import { extractPgUniqueViolation } from "./pg-error-helpers";
import { assertParentDepthOk, MAX_TREE_DEPTH } from "./validate-category-tree";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import {
  RestoreWindowExpiredError,
  SlugTakenError,
} from "@/server/audit/error-codes";

export interface RestoreCategoryTenantInfo {
  id: string;
}

export const RestoreCategoryInputSchema = z.object({
  id: z.string().uuid(),
  confirm: z.literal(true),
});
export type RestoreCategoryInput = z.input<typeof RestoreCategoryInputSchema>;

export interface RestoreCategoryResult {
  /** Pre-restore snapshot (deletedAt populated). For audit `before`. */
  before: Category;
  /** Post-restore snapshot (deletedAt null). For audit `after`. */
  after: Category;
}

export async function restoreCategory(
  tx: Tx,
  tenant: RestoreCategoryTenantInfo,
  role: Role,
  input: RestoreCategoryInput,
): Promise<RestoreCategoryResult> {
  if (!isWriteRole(role)) {
    throw new Error("restoreCategory: role not permitted");
  }
  const parsed = RestoreCategoryInputSchema.parse(input);

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('categories_tree:' || ${tenant.id}))`,
  );

  const beforeRows = await tx
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
        eq(categories.id, parsed.id),
        eq(categories.tenantId, tenant.id),
        isNotNull(categories.deletedAt),
      ),
    )
    .limit(1);
  const beforeRow = beforeRows[0];
  if (!beforeRow) {
    throw new TRPCError({ code: "NOT_FOUND", message: "category not found" });
  }

  if (
    beforeRow.deletedAt !== null &&
    Date.now() - beforeRow.deletedAt.getTime() > 30 * 24 * 60 * 60 * 1000
  ) {
    throw new RestoreWindowExpiredError();
  }

  let restoredDepth = 1;
  if (beforeRow.parentId !== null) {
    const parentRows = await tx
      .select({
        id: categories.id,
        deletedAt: categories.deletedAt,
      })
      .from(categories)
      .where(
        and(
          eq(categories.id, beforeRow.parentId),
          eq(categories.tenantId, tenant.id),
        ),
      )
      .limit(1);
    const parent = parentRows[0];
    if (!parent || parent.deletedAt !== null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "parent_still_removed",
      });
    }
    const { parentDepth } = await assertParentDepthOk(
      tx,
      tenant.id,
      beforeRow.parentId,
    );
    restoredDepth = parentDepth + 1;
  }
  if (restoredDepth > MAX_TREE_DEPTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "category_depth_exceeded",
    });
  }

  const beforeParsed = CategorySchema.parse({
    ...beforeRow,
    depth: restoredDepth,
  });

  let updatedRows;
  try {
    updatedRows = await tx
      .update(categories)
      .set({ deletedAt: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(categories.id, parsed.id),
          eq(categories.tenantId, tenant.id),
          isNotNull(categories.deletedAt),
          sql`now() - ${categories.deletedAt} <= interval '30 days'`,
        ),
      )
      .returning();
  } catch (err) {
    if (extractPgUniqueViolation(err, "categories_tenant_slug_unique_live")) {
      throw new SlugTakenError(err);
    }
    throw err;
  }

  if (updatedRows.length === 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: "category not found" });
  }

  const afterParsed = CategorySchema.parse({
    ...updatedRows[0]!,
    depth: restoredDepth,
  });
  return { before: beforeParsed, after: afterParsed };
}
