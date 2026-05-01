/**
 * Pure validation helpers for variant + option services (chunk 1a.5.1).
 *
 * Spec reference: §1 "Helpers". No DB calls — every function here works
 * on plain objects. Service layer composes these around its DB reads/
 * writes for advisory-lock-bracketed correctness.
 *
 * Caps from prd §3.3 are exported here so the migration, the Zod
 * schemas, and the UI layer (1a.5.2/1a.5.3) all import from one place.
 *
 * Error codes thrown match the closed-set wire messages defined in spec
 * §2; transports (tRPC `mutationProcedure`, MCP `dispatchTool`) translate
 * the bare `Error.message` into a typed `TRPCError({code,message})` /
 * `McpError(...)` envelope.
 */

/** Max number of option types attached to a single product (prd §3.3). */
export const MAX_OPTIONS_PER_PRODUCT = 3;

/** Max number of variant rows on a single product (prd §3.3). */
export const MAX_VARIANTS_PER_PRODUCT = 100;

/**
 * Defensive cap on values per option type. Realistic catalogs use ≤ ~30,
 * but pathological inputs could pile up rows that the cartesian-product
 * UI couldn't render cleanly — bound it to 100 for predictability.
 */
export const MAX_VALUES_PER_OPTION = 100;

interface VariantTuple {
  optionValueIds: readonly string[];
}

/**
 * Reject inputs in which two variants share the same `optionValueIds`
 * tuple. Tuple ORDER is significant (each option type holds a fixed
 * index in the tuple), so `[a,b]` and `[b,a]` are distinct.
 *
 * Two empty tuples ARE a duplicate — single-default mode permits exactly
 * one empty-tuple variant (see `assertVariantOptionTupleShape`).
 */
export function assertNoDuplicateVariantCombinations(
  variants: readonly VariantTuple[],
): void {
  const seen = new Set<string>();
  for (const v of variants) {
    // ASCII unit separator (0x1F) is a safe joiner for uuid arrays;
    // uuids cannot contain it, so the joined string is collision-free.
    const key = v.optionValueIds.join("\x1f");
    if (seen.has(key)) {
      throw new Error("duplicate_variant_combination");
    }
    seen.add(key);
  }
}

/**
 * Each variant's `optionValueIds` length must equal the product's
 * current option-type count. This invariant is load-bearing for 1a.5.3:
 * without it, the cascade-on-remove flow cannot reliably hard-delete
 * dependent variants (jsonb arrays aren't FKs).
 *
 * Single-default mode: when the product has zero options, exactly one
 * empty-tuple variant is allowed. Two or more empty-tuple variants
 * throw `default_variant_required`.
 *
 * Tuple-length mismatches (whether shorter or longer than
 * `currentOptionCount`) throw `option_value_not_found` — the same opaque
 * shape used for cross-tenant / phantom-id probes (spec §6).
 */
export function assertVariantOptionTupleShape(
  variants: readonly VariantTuple[],
  currentOptionCount: number,
): void {
  if (currentOptionCount === 0) {
    if (variants.length > 1) {
      throw new Error("default_variant_required");
    }
    return;
  }
  for (const v of variants) {
    if (v.optionValueIds.length !== currentOptionCount) {
      throw new Error("option_value_not_found");
    }
  }
}
