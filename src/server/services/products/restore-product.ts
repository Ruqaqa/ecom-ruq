/**
 * `restoreProduct` — admin product restore.
 *
 * Asymmetric to delete:
 *   - No `expectedUpdatedAt`. Soft-deleted rows aren't editable in the
 *     default admin list, so an OCC token would be theatre. Concurrency
 *     of restore+restore on the same row is naturally racy and
 *     idempotent — both calls land on `deletedAt = null`.
 *   - 30-day recovery window enforced at the DB seam. Window-expired
 *     rows surface RestoreWindowExpiredError; transports translate to
 *     BAD_REQUEST `restore_expired` (it's a precondition fail, not a
 *     missing row).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { products } from "@/server/db/schema/catalog";
import {
  ProductOwnerSchema,
  type ProductOwner,
} from "./create-product";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import { RestoreWindowExpiredError } from "@/server/audit/error-codes";

export interface RestoreProductTenantInfo {
  id: string;
}

export const RestoreProductInputSchema = z.object({
  id: z.string().uuid(),
  // Symmetry with delete — restore un-hides a SKU, possibly removed for
  // compliance/takedown. `z.literal(true)` rejects absence/false.
  confirm: z.literal(true),
});
export type RestoreProductInput = z.input<typeof RestoreProductInputSchema>;

export interface RestoreProductResult {
  /** Pre-restore row (deletedAt populated). For audit `before` payload. */
  before: ProductOwner;
  /** Post-restore row (deletedAt null). For audit `after` payload. */
  audit: ProductOwner;
}

export async function restoreProduct(
  tx: Tx,
  // tenantId is from the authenticated context — never from input.
  tenant: RestoreProductTenantInfo,
  role: Role,
  input: RestoreProductInput,
): Promise<RestoreProductResult> {
  if (!isWriteRole(role)) {
    throw new Error("restoreProduct: role not permitted");
  }
  const parsed = RestoreProductInputSchema.parse(input);

  // 1. SELECT pre-restore row. WHERE id, tenant_id, deleted_at IS NOT NULL.
  //    Cross-tenant ids fail this filter via tenant_id — same NOT_FOUND
  //    shape as a phantom UUID. IDOR-safe.
  const beforeRows = await tx
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      description: products.description,
      status: products.status,
      costPriceMinor: products.costPriceMinor,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt,
      deletedAt: products.deletedAt,
    })
    .from(products)
    .where(
      and(
        eq(products.id, parsed.id),
        eq(products.tenantId, tenant.id),
        isNotNull(products.deletedAt),
      ),
    )
    .limit(1);
  const beforeRow = beforeRows[0];
  if (!beforeRow) {
    throw new TRPCError({ code: "NOT_FOUND", message: "product not found" });
  }
  const beforeParsed = ProductOwnerSchema.parse(beforeRow);

  // 2. Recovery-window cutoff at the DB seam. now() - deletedAt > 30d
  //    is forensically distinct from "row exists" (it does) and from
  //    "concurrent write" (none happened) — own error class.
  if (
    beforeParsed.deletedAt !== null &&
    Date.now() - beforeParsed.deletedAt.getTime() > 30 * 24 * 60 * 60 * 1000
  ) {
    throw new RestoreWindowExpiredError();
  }

  // 3. UPDATE — clears deletedAt, advances updatedAt. The window
  //    predicate is repeated in the WHERE so a row that races past the
  //    cutoff between SELECT and UPDATE doesn't slip through.
  // products_tenant_slug_unique is unconditional — restore cannot
  // collide. Revisit if a partial-on-NULL index is ever introduced.
  const updatedRows = await tx
    .update(products)
    .set({ deletedAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(products.id, parsed.id),
        eq(products.tenantId, tenant.id),
        isNotNull(products.deletedAt),
        sql`now() - ${products.deletedAt} <= interval '30 days'`,
      ),
    )
    .returning();

  if (updatedRows.length === 0) {
    // Race between SELECT and UPDATE: the row got purged or the window
    // tipped. Treat as NOT_FOUND — the operator can re-list.
    throw new TRPCError({ code: "NOT_FOUND", message: "product not found" });
  }

  const auditFull = ProductOwnerSchema.parse(updatedRows[0]!);
  return { before: beforeParsed, audit: auditFull };
}
