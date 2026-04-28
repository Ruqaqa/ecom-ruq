/**
 * `setProductCategories` — admin product↔category linkage write (chunk 1a.4.2).
 *
 * SET-REPLACE contract (decision lock from security):
 *   - `categoryIds` is the desired full set; service computes diff and
 *     applies attach/detach atomically inside the caller's tx.
 *   - One mutation, one MCP tool. No paired attach/detach surface.
 *
 * Setting categories also bumps `products.updated_at`. The product's
 * category linkage is part of its observable state — bumping the
 * timestamp is correct, not incidental.
 *
 * Shape rules (parallel to update-product.ts):
 *   1. No `withTenant` / no tx open — adapter owns the lifecycle.
 *   2. No audit write — the adapter (`mutationProcedure` for tRPC,
 *      `auditMode:"mutation"` for MCP) wraps the mutation.
 *   3. Tenant arrives as a narrow `{ id }` projection.
 *   4. Role arrives from `ctx.role` (adapter-derived); never from input.
 *   5. Defense-in-depth role gate (owner+staff) inside the service so a
 *      wiring bug surfaces loudly rather than mutating with stale input.
 *
 * Concurrency:
 *   - OCC anchored on the product row. The first SQL is an UPDATE of
 *     `products` that sets `updated_at = now()` WHERE id, tenant_id,
 *     deleted_at IS NULL, and the OCC token matches. Empty result →
 *     disambiguating SELECT (gone vs stale) → NOT_FOUND or
 *     `StaleWriteError`. Mirrors `updateProduct`.
 *   - Desired-set existence check uses `FOR SHARE` so concurrent
 *     soft-deletes are blocked for the rest of this transaction. Without
 *     the lock, a race could delete a category between the existence
 *     check and the INSERT, and the composite same-tenant FK would
 *     surface a constraint name we cannot leak. Opaque `category_not_found`
 *     is the only public failure shape on the desired set.
 *
 * Failure mapping:
 *   - product missing in tenant (incl. cross-tenant probe, soft-deleted)
 *     → TRPCError NOT_FOUND `product_not_found`.
 *   - OCC mismatch → `StaleWriteError("set_product_categories")`.
 *   - any desired categoryId not live in tenant (cross-tenant probe,
 *     phantom uuid, soft-deleted) → TRPCError BAD_REQUEST
 *     `category_not_found`. Never echoes the offending id or constraint
 *     name.
 *   - 33+ ids in input → Zod validation failure (`category_set_too_large`).
 *   - duplicate ids in input → silently deduped via Zod transform.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { products, productCategories, categories } from "@/server/db/schema/catalog";
import { StaleWriteError } from "@/server/audit/error-codes";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";

export interface SetProductCategoriesTenantInfo {
  id: string;
}

// Plain Zod object (no `.transform`) so MCP `tools/list` can compile it
// to JSON Schema. Zod 4's `z.toJSONSchema` cannot represent transforms
// and crashes the entire tools/list response when ANY tool's input
// schema contains one. We dedupe duplicate ids inside the service body
// instead — the wire contract is set semantics either way.
export const SetProductCategoriesInputSchema = z
  .object({
    productId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    categoryIds: z
      .array(z.string().uuid())
      .max(32, "category_set_too_large"),
  })
  .strict();

export type SetProductCategoriesInput = z.input<
  typeof SetProductCategoriesInputSchema
>;

export const ProductCategoryRefSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
});
export type ProductCategoryRef = z.infer<typeof ProductCategoryRefSchema>;

export const SetProductCategoriesResultSchema = z.object({
  before: z.object({
    productId: z.string().uuid(),
    categories: z.array(ProductCategoryRefSchema),
  }),
  after: z.object({
    productId: z.string().uuid(),
    categories: z.array(ProductCategoryRefSchema),
  }),
  productUpdatedAt: z.date(),
});
export type SetProductCategoriesResult = z.infer<
  typeof SetProductCategoriesResultSchema
>;

export async function setProductCategories(
  tx: Tx,
  tenant: SetProductCategoriesTenantInfo,
  role: Role,
  input: SetProductCategoriesInput,
): Promise<SetProductCategoriesResult> {
  if (!isWriteRole(role)) {
    throw new Error("setProductCategories: role not permitted");
  }
  const validated = SetProductCategoriesInputSchema.parse(input);
  // Dedupe inside the service rather than via a Zod `.transform` because
  // the latter makes the schema unprintable as JSON Schema (Zod 4
  // limitation). Input may contain repeats from a racy multi-select
  // picker; the wire contract is set semantics.
  const parsed = {
    ...validated,
    categoryIds: Array.from(new Set(validated.categoryIds)),
  };

  // 1. Acquire the product row under OCC and bump updated_at. Empty
  //    result → disambiguate gone vs stale.
  const expectedIso = parsed.expectedUpdatedAt;
  const updatedRows = await tx
    .update(products)
    .set({ updatedAt: sql`now()` })
    .where(
      and(
        eq(products.id, parsed.productId),
        eq(products.tenantId, tenant.id),
        isNull(products.deletedAt),
        sql`date_trunc('milliseconds', ${products.updatedAt}) = date_trunc('milliseconds', ${expectedIso}::timestamptz)`,
      ),
    )
    .returning({ id: products.id, updatedAt: products.updatedAt });

  if (updatedRows.length === 0) {
    const probeRows = await tx
      .select({ updatedAt: products.updatedAt })
      .from(products)
      .where(
        and(
          eq(products.id, parsed.productId),
          eq(products.tenantId, tenant.id),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);
    if (probeRows.length === 0) {
      // Same shape regardless of cross-tenant probe / soft-deleted /
      // never-existed — IDOR existence-leak guard.
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "product_not_found",
      });
    }
    throw new StaleWriteError("set_product_categories");
  }
  const productRow = updatedRows[0]!;

  // 2. Read the current set (for the audit `before` payload).
  const currentRows = await tx
    .select({
      id: productCategories.categoryId,
      slug: categories.slug,
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
      ),
    );
  const beforeCategories = currentRows.map((r) => ({
    id: r.id,
    slug: r.slug,
  }));

  // 3. Existence-check the desired set, locking each row with FOR SHARE
  //    so concurrent soft-deletes are blocked for the rest of this
  //    transaction. The lock is load-bearing — without it a race could
  //    soft-delete a category between this SELECT and the INSERT below,
  //    and the composite same-tenant FK would surface a constraint name
  //    we cannot leak. The opaque `category_not_found` shape is the
  //    only public failure for the desired set.
  let desiredCategories: Array<{ id: string; slug: string }> = [];
  if (parsed.categoryIds.length > 0) {
    const desiredRows = await tx
      .select({ id: categories.id, slug: categories.slug })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, tenant.id),
          inArray(categories.id, parsed.categoryIds),
          isNull(categories.deletedAt),
        ),
      )
      .for("share");
    if (desiredRows.length !== parsed.categoryIds.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "category_not_found",
      });
    }
    desiredCategories = desiredRows.map((r) => ({ id: r.id, slug: r.slug }));
  }

  // 4. Diff.
  const currentIds = new Set(beforeCategories.map((c) => c.id));
  const desiredIds = new Set(parsed.categoryIds);
  const toAttach = parsed.categoryIds.filter((id) => !currentIds.has(id));
  const toDetach = beforeCategories
    .map((c) => c.id)
    .filter((id) => !desiredIds.has(id));

  // 5. Detach.
  if (toDetach.length > 0) {
    await tx
      .delete(productCategories)
      .where(
        and(
          eq(productCategories.tenantId, tenant.id),
          eq(productCategories.productId, parsed.productId),
          inArray(productCategories.categoryId, toDetach),
        ),
      );
  }

  // 6. Attach. ON CONFLICT DO NOTHING is belt-and-braces — the diff above
  //    already excludes already-linked rows, but a concurrent attach by
  //    another caller (which the FOR SHARE on categories doesn't block)
  //    could race in. The composite PK is the actual safety net.
  if (toAttach.length > 0) {
    await tx
      .insert(productCategories)
      .values(
        toAttach.map((categoryId) => ({
          tenantId: tenant.id,
          productId: parsed.productId,
          categoryId,
        })),
      )
      .onConflictDoNothing();
  }

  // 7. After-set is the desired set we just verified live. Order by id
  //    for determinism (callers and audit consumers shouldn't depend on
  //    insert order).
  const afterCategories = [...desiredCategories].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const beforeCategoriesSorted = [...beforeCategories].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  return SetProductCategoriesResultSchema.parse({
    before: {
      productId: parsed.productId,
      categories: beforeCategoriesSorted,
    },
    after: {
      productId: parsed.productId,
      categories: afterCategories,
    },
    productUpdatedAt: productRow.updatedAt,
  });
}
