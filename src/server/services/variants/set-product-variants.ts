/**
 * `setProductVariants` — admin variant-set write (chunk 1a.5.1).
 *
 * SET-REPLACE contract (decision lock from spec §1):
 *   - `variants[]` is the desired full set of variant rows. The service
 *     computes diff vs current and applies INSERT/UPDATE/DELETE
 *     atomically inside the caller's tx.
 *   - HARD DELETE on diff-removal: a variant currently on the product
 *     whose id is missing from input is hard-deleted. Variants do not
 *     have a `deletedAt`; the parent product's soft-delete is the
 *     broader recovery net (prd §3.3).
 *
 * Setting variants also bumps `products.updated_at` — the variant set
 * is part of the product's observable state.
 *
 * Concurrency:
 *   - Per-product advisory lock acquired up front (same key as
 *     setProductOptions). Serialises against concurrent edits + against
 *     concurrent option-set changes that could move the tuple-shape
 *     under us.
 *   - OCC anchored on the product row.
 *   - `FOR SHARE` lock on the relevant `product_option_values` rows
 *     during the existence check (spec §5: blocks concurrent
 *     soft-delete / removal of a value mid-tx).
 *
 * Failure mapping (closed-set wire messages):
 *   - product missing in tenant → NOT_FOUND `product_not_found`.
 *   - OCC mismatch → `StaleWriteError`.
 *   - tuple length ≠ current option count, or any value-id not on
 *     this product → BAD_REQUEST `option_value_not_found`.
 *   - duplicate `optionValueIds` tuple in input → BAD_REQUEST
 *     `duplicate_variant_combination`.
 *   - zero options + >1 empty-tuple variants → BAD_REQUEST
 *     `default_variant_required`.
 *   - SKU collision (pg 23505 on tenant_sku_unique) → SkuTakenError;
 *     wire layer translates to CONFLICT `sku_taken`. Offending SKU
 *     never echoed (cross-tenant existence-leak guard).
 *   - input violates Zod (>100 variants, etc.) → ZodError → adapter
 *     maps to BAD_REQUEST.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  products,
  productOptions,
  productOptionValues,
  productVariants,
} from "@/server/db/schema/catalog";
import {
  SkuTakenError,
  StaleWriteError,
} from "@/server/audit/error-codes";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import {
  MAX_OPTIONS_PER_PRODUCT,
  MAX_VARIANTS_PER_PRODUCT,
  assertNoDuplicateVariantCombinations,
  assertVariantOptionTupleShape,
} from "./validate-variants";
import {
  buildVariantsAuditSnapshot,
  type VariantsAuditSnapshot,
} from "./audit-snapshot";
import { extractPgSkuViolation } from "./pg-error-helpers";

export interface SetProductVariantsTenantInfo {
  id: string;
}

const VariantInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    sku: z.string().trim().min(1).max(64),
    priceMinor: z.number().int().nonnegative(),
    currency: z.string().trim().length(3).default("SAR"),
    stock: z.number().int().nonnegative(),
    active: z.boolean().default(true),
    optionValueIds: z.array(z.string().uuid()).max(MAX_OPTIONS_PER_PRODUCT),
  })
  .strict();

export const SetProductVariantsInputSchema = z
  .object({
    productId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    variants: z.array(VariantInputSchema).max(MAX_VARIANTS_PER_PRODUCT),
  })
  .strict();
export type SetProductVariantsInput = z.input<
  typeof SetProductVariantsInputSchema
>;

const VariantRefSchema = z.object({
  id: z.string().uuid(),
  sku: z.string(),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string(),
  stock: z.number().int().nonnegative(),
  active: z.boolean(),
  optionValueIds: z.array(z.string().uuid()),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type VariantRef = z.infer<typeof VariantRefSchema>;

const VariantsAuditSnapshotSchema = z.object({
  productId: z.string().uuid(),
  count: z.number().int().nonnegative(),
  ids: z.array(z.string().uuid()),
  hash: z.string(),
});

export const SetProductVariantsResultSchema = z.object({
  before: VariantsAuditSnapshotSchema,
  after: VariantsAuditSnapshotSchema,
  productUpdatedAt: z.date(),
  variants: z.array(VariantRefSchema),
});
export type SetProductVariantsResult = z.infer<
  typeof SetProductVariantsResultSchema
>;

interface CurrentVariantRow {
  id: string;
  sku: string;
  priceMinor: number;
  currency: string;
  stock: number;
  active: boolean;
  optionValueIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export async function setProductVariants(
  tx: Tx,
  tenant: SetProductVariantsTenantInfo,
  role: Role,
  input: SetProductVariantsInput,
): Promise<SetProductVariantsResult> {
  if (!isWriteRole(role)) {
    throw new Error("setProductVariants: role not permitted");
  }
  const parsed = SetProductVariantsInputSchema.parse(input);

  // Per-product advisory lock — same key as setProductOptions.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('product_variants:' || ${tenant.id} || ':' || ${parsed.productId}))`,
  );

  // 1. OCC-anchored UPDATE on products.
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
    const probe = await tx
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
    if (probe.length === 0) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "product_not_found",
      });
    }
    throw new StaleWriteError("set_product_variants");
  }
  const productRow = updatedRows[0]!;

  // 2. Read the product's current options + their value-ids. The
  //    union of value-ids defines what tuples a variant may reference.
  const currentOptionRows = await tx
    .select({ id: productOptions.id })
    .from(productOptions)
    .where(
      and(
        eq(productOptions.tenantId, tenant.id),
        eq(productOptions.productId, parsed.productId),
      ),
    );
  const currentOptionIds = currentOptionRows.map((r) => r.id);
  const currentOptionCount = currentOptionIds.length;

  // 3. Existence check on the union of input optionValueIds. FOR SHARE
  //    blocks concurrent removals of these rows for the rest of the tx
  //    — the lock is load-bearing for the same-tenant integrity guarantee
  //    of the JSONB optionValueIds column (spec §5).
  const referencedValueIds = Array.from(
    new Set(parsed.variants.flatMap((v) => v.optionValueIds)),
  );
  const liveValueIds = new Set<string>();
  if (referencedValueIds.length > 0) {
    if (currentOptionIds.length === 0) {
      // Product has no options but a variant references value-ids → all
      // referenced ids are necessarily not on this product. Surface as
      // option_value_not_found (opaque shape).
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "option_value_not_found",
      });
    }
    const liveRows = await tx
      .select({ id: productOptionValues.id })
      .from(productOptionValues)
      .where(
        and(
          eq(productOptionValues.tenantId, tenant.id),
          inArray(productOptionValues.optionId, currentOptionIds),
          inArray(productOptionValues.id, referencedValueIds),
        ),
      )
      .for("share");
    for (const r of liveRows) liveValueIds.add(r.id);
    if (liveValueIds.size !== referencedValueIds.length) {
      // Any referenced id that didn't surface — cross-tenant, wrong-
      // product, or phantom — produces the same opaque shape.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "option_value_not_found",
      });
    }
  }

  // 4. Tuple-shape invariants (load-bearing for 1a.5.3 cascade).
  try {
    assertVariantOptionTupleShape(parsed.variants, currentOptionCount);
    assertNoDuplicateVariantCombinations(parsed.variants);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "validation_failed";
    throw new TRPCError({ code: "BAD_REQUEST", message: msg });
  }

  // 5. Read current variants for diff + audit `before`.
  const currentVariants = (await tx
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      priceMinor: productVariants.priceMinor,
      currency: productVariants.currency,
      stock: productVariants.stock,
      active: productVariants.active,
      optionValueIds: productVariants.optionValueIds,
      createdAt: productVariants.createdAt,
      updatedAt: productVariants.updatedAt,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.tenantId, tenant.id),
        eq(productVariants.productId, parsed.productId),
      ),
    )) as CurrentVariantRow[];

  const currentVariantById = new Map(currentVariants.map((v) => [v.id, v]));

  // 6. Validate input ids: any input id must reference a current variant
  //    on this product (cross-tenant / wrong-product / phantom is opaque).
  for (const v of parsed.variants) {
    if (v.id !== undefined && !currentVariantById.has(v.id)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "variant_not_found",
      });
    }
  }

  // 7. Diff: insert vs update vs delete.
  const inputIdSet = new Set<string>();
  for (const v of parsed.variants) {
    if (v.id !== undefined) inputIdSet.add(v.id);
  }
  const variantsToDelete = currentVariants
    .filter((v) => !inputIdSet.has(v.id))
    .map((v) => v.id);

  // 8. Apply.
  if (variantsToDelete.length > 0) {
    await tx
      .delete(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenant.id),
          eq(productVariants.productId, parsed.productId),
          inArray(productVariants.id, variantsToDelete),
        ),
      );
  }
  for (const v of parsed.variants) {
    if (v.id !== undefined) {
      try {
        await tx
          .update(productVariants)
          .set({
            sku: v.sku,
            priceMinor: v.priceMinor,
            currency: v.currency,
            stock: v.stock,
            active: v.active,
            optionValueIds: v.optionValueIds,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(productVariants.id, v.id),
              eq(productVariants.tenantId, tenant.id),
              eq(productVariants.productId, parsed.productId),
            ),
          );
      } catch (err) {
        if (extractPgSkuViolation(err)) throw new SkuTakenError(err);
        throw err;
      }
    } else {
      try {
        await tx.insert(productVariants).values({
          tenantId: tenant.id,
          productId: parsed.productId,
          sku: v.sku,
          priceMinor: v.priceMinor,
          currency: v.currency,
          stock: v.stock,
          active: v.active,
          optionValueIds: v.optionValueIds,
        });
      } catch (err) {
        if (extractPgSkuViolation(err)) throw new SkuTakenError(err);
        throw err;
      }
    }
  }

  // 9. Re-read the post-state for the wire return + audit `after`.
  const finalVariants = (await tx
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      priceMinor: productVariants.priceMinor,
      currency: productVariants.currency,
      stock: productVariants.stock,
      active: productVariants.active,
      optionValueIds: productVariants.optionValueIds,
      createdAt: productVariants.createdAt,
      updatedAt: productVariants.updatedAt,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.tenantId, tenant.id),
        eq(productVariants.productId, parsed.productId),
      ),
    )
    .orderBy(productVariants.createdAt, productVariants.id)) as CurrentVariantRow[];

  const before: VariantsAuditSnapshot = buildVariantsAuditSnapshot({
    productId: parsed.productId,
    variants: currentVariants.map((v) => ({
      id: v.id,
      sku: v.sku,
      priceMinor: v.priceMinor,
      currency: v.currency,
      stock: v.stock,
      active: v.active,
      optionValueIds: v.optionValueIds,
    })),
  });
  const after: VariantsAuditSnapshot = buildVariantsAuditSnapshot({
    productId: parsed.productId,
    variants: finalVariants.map((v) => ({
      id: v.id,
      sku: v.sku,
      priceMinor: v.priceMinor,
      currency: v.currency,
      stock: v.stock,
      active: v.active,
      optionValueIds: v.optionValueIds,
    })),
  });

  return SetProductVariantsResultSchema.parse({
    before,
    after,
    productUpdatedAt: productRow.updatedAt,
    variants: finalVariants,
  });
}
