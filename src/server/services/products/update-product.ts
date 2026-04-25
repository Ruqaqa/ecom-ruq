/**
 * `updateProduct` — admin product edit (chunk 1a.2).
 *
 * Shape rules (parallel to createProduct):
 *   1. No `withTenant` / no tx open — adapter owns the lifecycle.
 *   2. Sparse update: every editable field is `.optional()`; `key in
 *      input` triggers SET. `costPriceMinor: null` explicitly clears it
 *      (vs key absent = leave it alone).
 *   3. Optimistic concurrency via `expectedUpdatedAt`. The UPDATE WHERE
 *      includes `updated_at = $expected`; an empty RETURNING then SELECTs
 *      the row to disambiguate two failure modes:
 *        - row gone (deleted/wrong tenant/wrong id) → NOT_FOUND
 *        - row exists with different updated_at  → StaleWriteError
 *   4. Tier-B input gate: `costPriceMinor` is owner-only for both reads
 *      and writes. Staff submitting it (set OR clear) is rejected with
 *      FORBIDDEN before the SQL fires.
 *   5. Slug collision (pg 23505 on products_tenant_slug_unique) maps to
 *      TRPCError CONFLICT 'slug_taken' — closed-set wire message; the
 *      offending value never echoes back. Audit-wrap still classifies
 *      pg 23505 → 'conflict'.
 *   6. Service returns `{ public, audit, before }`:
 *        - public — role-gated wire shape (Tier-B stripped for non-write)
 *        - audit  — always full ProductOwner shape so audit-wrap records
 *                   the post-update Tier-B value even on staff edits
 *        - before — pre-update full ProductOwner snapshot for the
 *                   audit `before` payload
 *   7. No `withTenant` invocation, no audit write — adapter wraps the
 *      whole tx + writes the audit row.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { products } from "@/server/db/schema/catalog";
import { localizedTextPartial } from "@/lib/i18n/localized";
import { slugSchema } from "@/lib/product-slug";
import {
  ProductOwnerSchema,
  ProductPublicSchema,
  type ProductOwner,
  type ProductPublic,
} from "./create-product";
import { extractPgUniqueViolation } from "./pg-error-helpers";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import { SlugTakenError, StaleWriteError } from "@/server/audit/error-codes";

export interface UpdateProductTenantInfo {
  id: string;
}

const EDITABLE_KEYS = [
  "slug",
  "name",
  "description",
  "status",
  "categoryId",
  "costPriceMinor",
] as const;

export const UpdateProductInputSchema = z
  .object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    slug: slugSchema.optional(),
    name: localizedTextPartial({ max: 256 }).optional(),
    description: localizedTextPartial({ max: 4096 }).optional(),
    status: z.enum(["draft", "active"]).optional(),
    categoryId: z.string().uuid().nullable().optional(),
    // `.nullable().optional()` lets the caller distinguish "leave alone"
    // (key absent) from "clear to null" (key present, value null) —
    // load-bearing for cost_price_minor. Owner-only by the runtime gate
    // below; staff submitting either value is rejected.
    costPriceMinor: z.number().int().nonnegative().nullable().optional(),
  })
  .refine(
    (input) => EDITABLE_KEYS.some((k) => k in input),
    { message: "at least one editable field required" },
  );

export type UpdateProductInput = z.input<typeof UpdateProductInputSchema>;

export interface UpdateProductResult {
  /** Wire shape — role-gated. */
  public: ProductOwner | ProductPublic;
  /** Full pre-update row (always ProductOwner). For the audit `before` payload. */
  before: ProductOwner;
  /** Full post-update row (always ProductOwner). For the audit `after` payload. */
  audit: ProductOwner;
}

export async function updateProduct(
  tx: Tx,
  tenant: UpdateProductTenantInfo,
  role: Role,
  input: UpdateProductInput,
): Promise<UpdateProductResult> {
  if (!isWriteRole(role)) {
    // Defense-in-depth — the transport-level requireRole gate is the
    // primary check. A non-write role reaching this service is a wiring
    // bug; surface it loudly rather than silently returning a public
    // shape with stale data.
    throw new Error("updateProduct: role not permitted");
  }
  const parsed = UpdateProductInputSchema.parse(input);

  // Tier-B input gate. `'costPriceMinor' in parsed` is true for both
  // explicit-set and explicit-null; `key in` is what distinguishes
  // "leave alone" (absent) from "edit". Staff submitting either form
  // is FORBIDDEN — owner-only for set AND clear.
  if ("costPriceMinor" in parsed && role !== "owner") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "cost_price_minor is owner-only",
    });
  }

  // 1. SELECT the full pre-update row. WHERE id, tenant_id, deleted_at IS NULL.
  const beforeRows = await tx
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      description: products.description,
      status: products.status,
      categoryId: products.categoryId,
      costPriceMinor: products.costPriceMinor,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt,
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
    // Same shape regardless of whether the row never existed, was
    // soft-deleted, or belongs to another tenant — IDOR existence-leak
    // guard.
    throw new TRPCError({ code: "NOT_FOUND", message: "product not found" });
  }
  const beforeParsed = ProductOwnerSchema.parse(beforeRow);

  // 2. Build the SET clause column-by-column. `key in parsed` is the
  //    discriminator; absent keys produce no SET fragment.
  const setClause: Record<string, unknown> = {
    // Always advance updated_at — captures the OCC token forward step.
    updatedAt: sql`now()`,
  };
  if ("slug" in parsed) setClause.slug = parsed.slug;
  if ("name" in parsed) {
    // Sparse name: merge the partial input over the existing JSONB
    // bilingual pair so en-only updates preserve the ar value (and
    // vice versa).
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
      // Same partial-merge pattern as name.
      const existing = (beforeParsed.description ?? {}) as {
        en?: string;
        ar?: string;
      };
      setClause.description = { ...existing, ...parsed.description };
    }
  }
  if ("status" in parsed) setClause.status = parsed.status;
  if ("categoryId" in parsed) setClause.categoryId = parsed.categoryId;
  if ("costPriceMinor" in parsed) setClause.costPriceMinor = parsed.costPriceMinor;

  // 3. UPDATE WHERE id, tenant_id, deleted_at IS NULL, updated_at = $expected.
  //
  // Postgres `timestamptz` is microsecond-resolution; JS `Date` is
  // millisecond. A naive `updated_at = $1` rejects every match because
  // the DB value carries sub-millisecond precision the client value
  // never knew about. Truncate both sides to milliseconds in the
  // comparison so the OCC token stays semantically equivalent without
  // a schema change.
  const expectedIso = parsed.expectedUpdatedAt; // already ISO-validated by Zod
  let updatedRows;
  try {
    updatedRows = await tx
      .update(products)
      .set(setClause)
      .where(
        and(
          eq(products.id, parsed.id),
          eq(products.tenantId, tenant.id),
          isNull(products.deletedAt),
          sql`date_trunc('milliseconds', ${products.updatedAt}) = date_trunc('milliseconds', ${expectedIso}::timestamptz)`,
        ),
      )
      .returning();
  } catch (err) {
    if (extractPgUniqueViolation(err, "products_tenant_slug_unique")) {
      throw new SlugTakenError(err);
    }
    throw err;
  }

  if (updatedRows.length === 0) {
    // 4. Disambiguating SELECT: was the row gone, or just stale?
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
    // Row exists; must be a stale write (updated_at advanced).
    throw new StaleWriteError("update_product");
  }

  const updatedRow = updatedRows[0]!;
  const auditFull = ProductOwnerSchema.parse(updatedRow);
  const wire =
    role === "owner" || role === "staff"
      ? auditFull
      : ProductPublicSchema.parse(updatedRow);

  return { public: wire, before: beforeParsed, audit: auditFull };
}
