/**
 * `createCategory` — admin category create (chunk 1a.4.1).
 *
 * Mirrors `createProduct` shape rules:
 *   1. No `withTenant` / no tx open — adapter owns the lifecycle.
 *   2. No audit write — adapter handles it.
 *   3. Tenant arrives as a narrowed projection.
 *   4. Role arrives from `ctx.role`, never from input.
 *   5. Output is the Zod gate.
 *
 * Tree invariants:
 *   - parent_id (if set) must exist in the tenant and be live (not
 *     soft-deleted) — else BAD_REQUEST `parent_not_found`.
 *   - parent_id (if set) must be at depth ≤ 2 so the new node lands at
 *     ≤ depth 3 — else BAD_REQUEST `category_depth_exceeded`.
 *
 * Slug shape via `slugSchema` (the same schema products use). Per-tenant
 * uniqueness among LIVE rows is enforced by the partial unique index
 * `categories_tenant_slug_unique_live`; pg 23505 → SlugTakenError.
 *
 * Bilingual: `name` requires both locales (Phase 1a UX shows both fields
 * up front; bilingual polish for missing-translation badges lands in
 * 1a.6). `description` is optional bilingual partial.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { categories } from "@/server/db/schema/catalog";
import { localizedText, localizedTextPartial } from "@/lib/i18n/localized";
import { slugSchema } from "@/lib/product-slug";
import { SlugTakenError } from "@/server/audit/error-codes";
import { extractPgUniqueViolation } from "./pg-error-helpers";
import { assertParentDepthOk } from "./validate-category-tree";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";

export interface CreateCategoryTenantInfo {
  id: string;
}

// `position` is now optional at the wire boundary. The admin create form
// no longer surfaces it (the operator reorders via the up/down arrows on
// the list page). Direct MCP callers may still supply a numeric position
// for back-compat — when omitted, the service computes
// `max(siblings.position) + 1` so new rows land at the bottom of their
// parent group.
export const CreateCategoryInputSchema = z.object({
  slug: slugSchema,
  name: localizedText({ max: 256 }),
  description: localizedTextPartial({ max: 4096 }).nullish(),
  parentId: z.string().uuid().nullable().default(null),
  position: z.number().int().nonnegative().optional(),
});
export type CreateCategoryInput = z.input<typeof CreateCategoryInputSchema>;

export const CategorySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.object({ en: z.string(), ar: z.string() }),
  description: z
    .object({ en: z.string().optional(), ar: z.string().optional() })
    .nullish(),
  parentId: z.string().uuid().nullable(),
  depth: z.number().int().min(1).max(3),
  position: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
});
export type Category = z.infer<typeof CategorySchema>;

export async function createCategory(
  tx: Tx,
  tenant: CreateCategoryTenantInfo,
  role: Role,
  input: CreateCategoryInput,
): Promise<Category> {
  if (!isWriteRole(role)) {
    throw new Error("createCategory: role not permitted");
  }
  const parsed = CreateCategoryInputSchema.parse(input);

  let depth = 1;
  if (parsed.parentId !== null) {
    const { parentDepth } = await assertParentDepthOk(
      tx,
      tenant.id,
      parsed.parentId,
    );
    depth = parentDepth + 1;
  }

  // Default `position` to `max(siblings.position) + 1` so new rows land
  // at the bottom of their parent group. MAX over an empty set is NULL
  // (coalesced to -1 → first row gets position 0). Caller can still
  // override explicitly via MCP.
  let resolvedPosition: number;
  if (parsed.position !== undefined) {
    resolvedPosition = parsed.position;
  } else {
    const parentFilter =
      parsed.parentId === null
        ? isNull(categories.parentId)
        : eq(categories.parentId, parsed.parentId);
    const maxRows = await tx
      .select({
        maxPos: sql<number>`COALESCE(MAX(${categories.position}), -1)`,
      })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, tenant.id),
          isNull(categories.deletedAt),
          parentFilter,
        ),
      );
    const currentMax = Number(maxRows[0]?.maxPos ?? -1);
    resolvedPosition = currentMax + 1;
  }

  let rows;
  try {
    rows = await tx
      .insert(categories)
      .values({
        tenantId: tenant.id,
        slug: parsed.slug,
        name: parsed.name,
        description: parsed.description,
        parentId: parsed.parentId,
        position: resolvedPosition,
      })
      .returning();
  } catch (err) {
    if (
      extractPgUniqueViolation(err, "categories_tenant_slug_unique_live")
    ) {
      throw new SlugTakenError(err);
    }
    throw err;
  }

  const row = rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "createCategory: insert returned no row",
    });
  }
  return CategorySchema.parse({ ...row, depth });
}
