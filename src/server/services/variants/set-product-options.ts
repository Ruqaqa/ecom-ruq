/**
 * `setProductOptions` — admin product option-types write
 * (chunk 1a.5.1, amended by chunk 1a.5.3).
 *
 * SET-REPLACE contract: `options[]` is the desired full set of option-
 * type axes for the product. The service computes diff vs current and
 * applies INSERT / UPDATE / DELETE atomically inside the caller's tx.
 *
 * REMOVAL CASCADE (1a.5.3 lifts the 1a.5.1 transitional refusal):
 *   - An option type present today and missing from the input is REMOVED.
 *     Every variant row whose `option_value_ids` JSONB array contains
 *     ANY value-id of the removed option is HARD-DELETED in the same
 *     tx, BEFORE the option-type row is deleted (so no read-snapshot
 *     ever observes a variant referencing a non-existent value-id).
 *   - An option value of a kept option type, present today and missing
 *     from the input, is REMOVED. Every variant row referencing that
 *     specific value-id is HARD-DELETED in the same tx.
 *   - The `product_option_values.option_id → product_options.(tenant_id,
 *     id) ON DELETE CASCADE` FK from migration 0011 physically removes
 *     value rows when their parent option row is deleted; the variant
 *     cleanup is necessarily app-layer because `option_value_ids` is
 *     JSONB, not a FK array.
 *   - Variants do NOT have a recovery window. The parent product's
 *     soft-delete (30-day window) is the broader safety net per
 *     prd §3.3.
 *
 * Setting options also bumps `products.updated_at` — the option-type
 * axes are part of the product's observable state.
 *
 * Shape rules (parallel to setProductCategories):
 *   1. No `withTenant` / no tx open — adapter owns the lifecycle.
 *   2. No audit write — the adapter wraps the mutation and reads
 *      `result.before` / `result.after` (already bounded snapshots).
 *   3. Tenant arrives as a narrow `{ id }` projection.
 *   4. Role arrives via `ctx.role`; never from input.
 *   5. Defense-in-depth role gate (owner+staff) inside the service.
 *
 * Concurrency:
 *   - Per-product advisory lock acquired up front:
 *     `pg_advisory_xact_lock(hashtext('product_variants:' || tenantId
 *      || ':' || productId))`. Released at tx commit/rollback.
 *     Serialises against concurrent setProductVariants on the same
 *     product so the cartesian/tuple-shape view is consistent.
 *   - OCC anchored on the product row. UPDATE products SET updated_at =
 *     now() WHERE id, tenant_id, deleted_at IS NULL, OCC matches.
 *     Empty result → disambiguate gone vs stale.
 *
 * Audit: `OptionsAuditSnapshot.after.cascadedVariantIds` carries every
 * variant id hard-deleted by this call (sorted; max 100). Never echoes
 * SKUs, never echoes localized name/value text, never echoes
 * option_value_ids tuples. The hash payload includes the sorted
 * cascadedVariantIds so cascade-different calls produce different hashes.
 *
 * Failure mapping (closed-set wire messages):
 *   - product missing in tenant (incl. cross-tenant probe, soft-deleted)
 *     → TRPCError NOT_FOUND `product_not_found`.
 *   - OCC mismatch → `StaleWriteError("set_product_options")`.
 *   - any input optionId not currently on this product (same-tenant
 *     wrong-product, cross-tenant, phantom) → BAD_REQUEST `option_not_found`.
 *   - any input value-id not currently on the matching option (same-
 *     tenant wrong-option, cross-tenant, phantom) → BAD_REQUEST
 *     `option_value_not_found`.
 *   - input violates Zod (>3 options, >100 values, etc.)
 *     → ZodError → tRPC adapter maps to BAD_REQUEST.
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
import { localizedText, type LocalizedText } from "@/lib/i18n/localized";
import { StaleWriteError } from "@/server/audit/error-codes";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import {
  MAX_OPTIONS_PER_PRODUCT,
  MAX_VALUES_PER_OPTION,
} from "./validate-variants";
import {
  buildOptionsAuditSnapshot,
  buildOptionsAuditAfterSnapshot,
  type OptionsAuditSnapshot,
  type OptionsAuditAfterSnapshot,
} from "./audit-snapshot";

export interface SetProductOptionsTenantInfo {
  id: string;
}

const OptionValueInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    value: localizedText({ max: 64 }),
  })
  .strict();

const OptionInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: localizedText({ max: 64 }),
    values: z
      .array(OptionValueInputSchema)
      .min(1)
      .max(MAX_VALUES_PER_OPTION),
  })
  .strict();

export const SetProductOptionsInputSchema = z
  .object({
    productId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    options: z.array(OptionInputSchema).max(MAX_OPTIONS_PER_PRODUCT),
  })
  .strict();
export type SetProductOptionsInput = z.input<
  typeof SetProductOptionsInputSchema
>;

const OptionValueRefSchema = z.object({
  id: z.string().uuid(),
  value: z.object({ en: z.string(), ar: z.string() }),
  position: z.number().int().nonnegative(),
});
const OptionRefSchema = z.object({
  id: z.string().uuid(),
  name: z.object({ en: z.string(), ar: z.string() }),
  position: z.number().int().nonnegative(),
  values: z.array(OptionValueRefSchema),
});
export type OptionRef = z.infer<typeof OptionRefSchema>;

const OptionsAuditSnapshotBeforeSchema = z.object({
  productId: z.string().uuid(),
  optionsCount: z.number().int().nonnegative(),
  optionIds: z.array(z.string().uuid()),
  valuesCount: z.number().int().nonnegative(),
  valueIds: z.array(z.string().uuid()),
  hash: z.string(),
});

// `after` carries the cascadedVariantIds payload — every variant id
// hard-deleted by the call (sorted, ids only). 1a.5.3 spec §1 +
// security spec §2.
const OptionsAuditSnapshotAfterSchema = OptionsAuditSnapshotBeforeSchema.extend({
  cascadedVariantIds: z.array(z.string().uuid()),
});

export const SetProductOptionsResultSchema = z.object({
  before: OptionsAuditSnapshotBeforeSchema,
  after: OptionsAuditSnapshotAfterSchema,
  productUpdatedAt: z.date(),
  options: z.array(OptionRefSchema),
  cascadedVariantIds: z.array(z.string().uuid()),
});
export type SetProductOptionsResult = z.infer<
  typeof SetProductOptionsResultSchema
>;

interface CurrentOptionRow {
  id: string;
  name: LocalizedText;
  position: number;
}

interface CurrentValueRow {
  id: string;
  optionId: string;
  value: LocalizedText;
  position: number;
}

export async function setProductOptions(
  tx: Tx,
  tenant: SetProductOptionsTenantInfo,
  role: Role,
  input: SetProductOptionsInput,
): Promise<SetProductOptionsResult> {
  if (!isWriteRole(role)) {
    throw new Error("setProductOptions: role not permitted");
  }
  const parsed = SetProductOptionsInputSchema.parse(input);

  // Per-product advisory lock — serialises against concurrent
  // setProductVariants and other setProductOptions calls on this
  // product. Released at tx commit/rollback.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('product_variants:' || ${tenant.id} || ':' || ${parsed.productId}))`,
  );

  // 1. OCC-anchored UPDATE on products. Empty result → disambiguate.
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
      // Same shape regardless of cross-tenant / soft-deleted / phantom.
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "product_not_found",
      });
    }
    throw new StaleWriteError("set_product_options");
  }
  const productRow = updatedRows[0]!;

  // 2. Read current options + values for the product.
  const currentOptionRows = (await tx
    .select({
      id: productOptions.id,
      name: productOptions.name,
      position: productOptions.position,
    })
    .from(productOptions)
    .where(
      and(
        eq(productOptions.tenantId, tenant.id),
        eq(productOptions.productId, parsed.productId),
      ),
    )) as CurrentOptionRow[];

  const currentOptionIds = currentOptionRows.map((r) => r.id);

  const currentValueRows: CurrentValueRow[] = currentOptionIds.length === 0
    ? []
    : ((await tx
        .select({
          id: productOptionValues.id,
          optionId: productOptionValues.optionId,
          value: productOptionValues.value,
          position: productOptionValues.position,
        })
        .from(productOptionValues)
        .where(
          and(
            eq(productOptionValues.tenantId, tenant.id),
            inArray(productOptionValues.optionId, currentOptionIds),
          ),
        )) as CurrentValueRow[]);

  // 3. Validate input ids against current state.
  const currentOptionIdSet = new Set(currentOptionIds);
  const currentValuesByOption = new Map<string, Set<string>>();
  for (const v of currentValueRows) {
    let s = currentValuesByOption.get(v.optionId);
    if (!s) {
      s = new Set<string>();
      currentValuesByOption.set(v.optionId, s);
    }
    s.add(v.id);
  }

  const inputOptionIds = new Set<string>();
  const inputValueIdsByOption = new Map<string, Set<string>>();
  for (const o of parsed.options) {
    if (o.id !== undefined) {
      if (!currentOptionIdSet.has(o.id)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "option_not_found",
        });
      }
      if (inputOptionIds.has(o.id)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "option_not_found",
        });
      }
      inputOptionIds.add(o.id);
      const liveValueIds = currentValuesByOption.get(o.id) ?? new Set<string>();
      const seen = new Set<string>();
      for (const v of o.values) {
        if (v.id !== undefined) {
          if (!liveValueIds.has(v.id) || seen.has(v.id)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "option_value_not_found",
            });
          }
          seen.add(v.id);
        }
      }
      inputValueIdsByOption.set(o.id, seen);
    }
  }

  // 4. Compute the removal sets — option types and individual values
  //    present today but missing from input. 1a.5.3 lifts the 1a.5.1
  //    transitional refusal: removals are now applied as a cascade.
  const removedOptionIds = currentOptionIds.filter(
    (id) => !inputOptionIds.has(id),
  );
  const removedValueIds: string[] = [];
  for (const [optionId, currentVids] of currentValuesByOption.entries()) {
    if (removedOptionIds.includes(optionId)) {
      // Option is being removed wholesale — its values disappear with
      // it via the ON DELETE CASCADE FK. Variant rows referencing them
      // are caught by the option-removal cascade below; the value-ids
      // are added to the doomed set so the variant SELECT covers them.
      for (const cid of currentVids) removedValueIds.push(cid);
      continue;
    }
    const kept = inputValueIdsByOption.get(optionId);
    if (!kept) continue;
    for (const cid of currentVids) {
      if (!kept.has(cid)) removedValueIds.push(cid);
    }
  }

  // 5. Cascade flow — variant cleanup BEFORE option/value rows are
  //    deleted, so no read-snapshot ever observes a variant pointing at
  //    a deleted value-id. Variants cleanup is necessarily app-layer
  //    because `option_value_ids` is JSONB, not an FK array.
  //
  //    Approach: SELECT every variant on this product, filter in JS
  //    against the doomed-value-id set. The bound is tiny — at most
  //    MAX_VARIANTS_PER_PRODUCT (100) variant rows × MAX_OPTIONS_PER_
  //    PRODUCT × MAX_VALUES_PER_OPTION (3 × 100 = 300) doomed value-ids.
  //    Keeps every identifier flowing through the prepared-statement
  //    parameter binder; no SQL string interpolation.
  const cascadedVariantIds: string[] = [];
  if (removedValueIds.length > 0) {
    const doomedSet = new Set(removedValueIds);
    const variantsOnProduct = await tx
      .select({
        id: productVariants.id,
        optionValueIds: productVariants.optionValueIds,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenant.id),
          eq(productVariants.productId, parsed.productId),
        ),
      );
    for (const v of variantsOnProduct) {
      const tuple = v.optionValueIds as readonly string[];
      for (const vid of tuple) {
        if (doomedSet.has(vid)) {
          cascadedVariantIds.push(v.id);
          break;
        }
      }
    }
    if (cascadedVariantIds.length > 0) {
      await tx
        .delete(productVariants)
        .where(
          and(
            eq(productVariants.tenantId, tenant.id),
            eq(productVariants.productId, parsed.productId),
            inArray(productVariants.id, cascadedVariantIds),
          ),
        );
    }
  }
  cascadedVariantIds.sort();

  // 6. Now delete the doomed option-type rows. The composite FK
  //    `product_option_values.option_id → product_options.(tenant_id, id)
  //    ON DELETE CASCADE` (migration 0011) physically removes the
  //    corresponding value rows.
  if (removedOptionIds.length > 0) {
    await tx
      .delete(productOptions)
      .where(
        and(
          eq(productOptions.tenantId, tenant.id),
          eq(productOptions.productId, parsed.productId),
          inArray(productOptions.id, removedOptionIds),
        ),
      );
  }

  // 7. Delete value rows for kept option types whose values were dropped.
  const keptValueRemovals = removedValueIds.filter((vid) => {
    const owner = currentValueRows.find((v) => v.id === vid);
    return owner ? !removedOptionIds.includes(owner.optionId) : false;
  });
  if (keptValueRemovals.length > 0) {
    await tx
      .delete(productOptionValues)
      .where(
        and(
          eq(productOptionValues.tenantId, tenant.id),
          inArray(productOptionValues.id, keptValueRemovals),
        ),
      );
  }

  // 8. Apply diff. Position is derived from input array index — operator-
  //    chosen reorder is implicit in array order.
  // First, UPDATE existing options (name + position) in-place.
  for (let i = 0; i < parsed.options.length; i++) {
    const o = parsed.options[i]!;
    if (o.id === undefined) continue;
    await tx
      .update(productOptions)
      .set({ name: o.name, position: i })
      .where(
        and(
          eq(productOptions.id, o.id),
          eq(productOptions.tenantId, tenant.id),
        ),
      );
    // Update existing values + insert new values for this kept option.
    for (let j = 0; j < o.values.length; j++) {
      const v = o.values[j]!;
      if (v.id !== undefined) {
        await tx
          .update(productOptionValues)
          .set({ value: v.value, position: j })
          .where(
            and(
              eq(productOptionValues.id, v.id),
              eq(productOptionValues.tenantId, tenant.id),
            ),
          );
      } else {
        await tx.insert(productOptionValues).values({
          tenantId: tenant.id,
          optionId: o.id,
          value: v.value,
          position: j,
        });
      }
    }
  }
  // Then, INSERT new options (those without an id) and their values.
  for (let i = 0; i < parsed.options.length; i++) {
    const o = parsed.options[i]!;
    if (o.id !== undefined) continue;
    const inserted = await tx
      .insert(productOptions)
      .values({
        tenantId: tenant.id,
        productId: parsed.productId,
        name: o.name,
        position: i,
      })
      .returning({ id: productOptions.id });
    const newOptionId = inserted[0]!.id;
    for (let j = 0; j < o.values.length; j++) {
      const v = o.values[j]!;
      await tx.insert(productOptionValues).values({
        tenantId: tenant.id,
        optionId: newOptionId,
        value: v.value,
        position: j,
      });
    }
  }

  // 9. Re-read the final state for the audit snapshot + wire return.
  const finalOptions = (await tx
    .select({
      id: productOptions.id,
      name: productOptions.name,
      position: productOptions.position,
    })
    .from(productOptions)
    .where(
      and(
        eq(productOptions.tenantId, tenant.id),
        eq(productOptions.productId, parsed.productId),
      ),
    )
    .orderBy(productOptions.position, productOptions.id)) as CurrentOptionRow[];

  const finalOptionIds = finalOptions.map((o) => o.id);
  const finalValues: CurrentValueRow[] = finalOptionIds.length === 0
    ? []
    : ((await tx
        .select({
          id: productOptionValues.id,
          optionId: productOptionValues.optionId,
          value: productOptionValues.value,
          position: productOptionValues.position,
        })
        .from(productOptionValues)
        .where(
          and(
            eq(productOptionValues.tenantId, tenant.id),
            inArray(productOptionValues.optionId, finalOptionIds),
          ),
        )
        .orderBy(
          productOptionValues.optionId,
          productOptionValues.position,
          productOptionValues.id,
        )) as CurrentValueRow[]);

  const valuesByOption = new Map<string, CurrentValueRow[]>();
  for (const v of finalValues) {
    const arr = valuesByOption.get(v.optionId) ?? [];
    arr.push(v);
    valuesByOption.set(v.optionId, arr);
  }

  const optionsWire: OptionRef[] = finalOptions.map((o) => ({
    id: o.id,
    name: o.name,
    position: o.position,
    values: (valuesByOption.get(o.id) ?? []).map((v) => ({
      id: v.id,
      value: v.value,
      position: v.position,
    })),
  }));

  // 10. Audit snapshots — bounded shapes (no localized text crosses).
  //     `after` carries the cascadedVariantIds so investigators can
  //     reconstruct removal intent from a single audit row, and the
  //     hash distinguishes cascade-true vs cascade-false post-states.
  const before: OptionsAuditSnapshot = buildOptionsAuditSnapshot({
    productId: parsed.productId,
    options: currentOptionRows.map((o) => ({
      id: o.id,
      position: o.position,
      values: (
        currentValueRows.filter((v) => v.optionId === o.id)
      ).map((v) => ({ id: v.id, position: v.position })),
    })),
  });
  const after: OptionsAuditAfterSnapshot = buildOptionsAuditAfterSnapshot(
    {
      productId: parsed.productId,
      options: optionsWire.map((o) => ({
        id: o.id,
        position: o.position,
        values: o.values.map((v) => ({ id: v.id, position: v.position })),
      })),
    },
    cascadedVariantIds,
  );

  return SetProductOptionsResultSchema.parse({
    before,
    after,
    productUpdatedAt: productRow.updatedAt,
    options: optionsWire,
    cascadedVariantIds,
  });
}
