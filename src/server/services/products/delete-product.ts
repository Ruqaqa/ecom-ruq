/**
 * `deleteProduct` — admin product soft-delete.
 *
 * Shape rules:
 *   1. No `withTenant` / no tx open — adapter owns the lifecycle.
 *   2. `confirm: z.literal(true)` is non-negotiable per CLAUDE.md §6 —
 *      the destructive-op gate. Missing/false confirm is a Zod
 *      validation_failed, NOT a silent no-op.
 *   3. Optimistic concurrency on `expectedUpdatedAt`. Same OCC pattern as
 *      `updateProduct` (date_trunc to milliseconds).
 *   4. Idempotency: re-deleting an already-deleted row REJECTS with
 *      NOT_FOUND, not silent success. The deleted row is invisible past
 *      the deleted_at filter, same shape as a phantom UUID — IDOR-safe.
 *   5. Returns `{ before, audit }` — both full ProductOwner snapshots.
 *      Transports use these as the audit before/after payloads and ship
 *      a small wire envelope separately. There is no `public` shape —
 *      the wire return is transport-specific.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { products } from "@/server/db/schema/catalog";
import {
  ProductOwnerSchema,
  type ProductOwner,
} from "./create-product";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import { StaleWriteError } from "@/server/audit/error-codes";

export interface DeleteProductTenantInfo {
  id: string;
}

export const DeleteProductInputSchema = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime(),
  // `z.literal(true)` rejects both absence and `false` — the destructive
  // op invariant per CLAUDE.md §6.
  confirm: z.literal(true),
});
export type DeleteProductInput = z.input<typeof DeleteProductInputSchema>;

export interface DeleteProductResult {
  /** Pre-delete row (deletedAt null). For audit `before` payload. */
  before: ProductOwner;
  /** Post-delete row (deletedAt populated). For audit `after` payload. */
  audit: ProductOwner;
}

export async function deleteProduct(
  tx: Tx,
  tenant: DeleteProductTenantInfo,
  role: Role,
  input: DeleteProductInput,
): Promise<DeleteProductResult> {
  if (!isWriteRole(role)) {
    throw new Error("deleteProduct: role not permitted");
  }
  const parsed = DeleteProductInputSchema.parse(input);

  // 1. SELECT the full pre-delete row. WHERE id, tenant_id, deleted_at IS NULL.
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
        isNull(products.deletedAt),
      ),
    )
    .limit(1);
  const beforeRow = beforeRows[0];
  if (!beforeRow) {
    // Same shape regardless of cause (never existed / wrong tenant /
    // already deleted) — IDOR existence-leak guard.
    throw new TRPCError({ code: "NOT_FOUND", message: "product not found" });
  }
  const beforeParsed = ProductOwnerSchema.parse(beforeRow);

  // 2. UPDATE WHERE id, tenant_id, deleted_at IS NULL, OCC matches.
  //    date_trunc('milliseconds') reuses the OCC pattern from
  //    update-product.ts:200 — pg microseconds vs JS milliseconds.
  const updatedRows = await tx
    .update(products)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(products.id, parsed.id),
        eq(products.tenantId, tenant.id),
        isNull(products.deletedAt),
        sql`date_trunc('milliseconds', ${products.updatedAt}) = date_trunc('milliseconds', ${parsed.expectedUpdatedAt}::timestamptz)`,
      ),
    )
    .returning();

  if (updatedRows.length === 0) {
    // 3. Disambiguating SELECT: gone, or stale?
    const probeRows = await tx
      .select({ updatedAt: products.updatedAt })
      .from(products)
      .where(
        and(
          eq(products.id, parsed.id),
          eq(products.tenantId, tenant.id),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);
    if (probeRows.length === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: "product not found" });
    }
    throw new StaleWriteError("delete_product");
  }

  const auditFull = ProductOwnerSchema.parse(updatedRows[0]!);
  return { before: beforeParsed, audit: auditFull };
}
