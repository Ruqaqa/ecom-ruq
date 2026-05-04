// Refs are call-scoped strings the agent supplies so a variant can
// point at a value the same call is creating. They never persist —
// resolution to UUIDs happens once, before variants are written.
import { z } from "zod";
import {
  MAX_OPTIONS_PER_PRODUCT,
  MAX_VALUES_PER_OPTION,
  MAX_VARIANTS_PER_PRODUCT,
} from "@/server/services/variants/validate-variants";
import { localizedText, localizedTextPartial } from "@/lib/i18n/localized";
import { slugSchema } from "@/lib/product-slug";

const refRegex = /^[a-z0-9_-]{1,32}$/;
const refSchema = z.string().regex(refRegex);

export const RichOptionValueInputSchema = z
  .object({
    ref: refSchema,
    value: localizedText({ max: 64 }),
  })
  .strict();
export type RichOptionValueInput = z.infer<typeof RichOptionValueInputSchema>;

export const RichOptionInputSchema = z
  .object({
    ref: refSchema,
    name: localizedText({ max: 64 }),
    values: z
      .array(RichOptionValueInputSchema)
      .min(1)
      .max(MAX_VALUES_PER_OPTION),
  })
  .strict();
export type RichOptionInput = z.input<typeof RichOptionInputSchema>;

export const RichVariantInputSchema = z
  .object({
    sku: z.string().trim().min(1).max(64),
    priceSar: z.number().nonnegative(),
    currency: z.string().trim().length(3).default("SAR"),
    stock: z.number().int().nonnegative(),
    active: z.boolean().default(true),
    optionValueRefs: z.array(z.string()).max(MAX_OPTIONS_PER_PRODUCT),
  })
  .strict();
export type RichVariantInput = z.input<typeof RichVariantInputSchema>;

const baseSchema = z
  .object({
    slug: slugSchema,
    name: localizedText({ max: 256 }),
    description: localizedTextPartial({ max: 4096 }).nullish(),
    status: z.enum(["draft", "active"]).default("draft"),
    options: z
      .array(RichOptionInputSchema)
      .max(MAX_OPTIONS_PER_PRODUCT)
      .default([]),
    variants: z
      .array(RichVariantInputSchema)
      .max(MAX_VARIANTS_PER_PRODUCT)
      .default([]),
    categoryIds: z.array(z.string().uuid()).max(32).default([]),
    dryRun: z.boolean().default(false),
  })
  .strict();

/**
 * Cross-field invariants:
 *   - option refs unique across `options[]`
 *   - value refs unique within each option
 *   - variant.optionValueRefs.length === options.length (or single-default
 *     mode: zero options + ≤ 1 empty-tuple variant)
 *   - each variant.optionValueRefs[i] resolves to a value defined under
 *     options[i] in this exact order
 *   - no two variants share the same resolved tuple
 *
 * Failures are surfaced as path-prefixed Zod issues so the AI agent can
 * correct the exact field.
 */
export const CreateProductRichInputSchema = baseSchema.superRefine(
  (input, ctx) => {
    // 1. option refs unique
    const seenOptionRefs = new Set<string>();
    for (let i = 0; i < input.options.length; i++) {
      const o = input.options[i]!;
      if (seenOptionRefs.has(o.ref)) {
        ctx.addIssue({
          code: "custom",
          path: ["options", i, "ref"],
          message: "option_ref_duplicate",
        });
      }
      seenOptionRefs.add(o.ref);
      // 2. value refs unique within this option
      const seenValueRefs = new Set<string>();
      for (let j = 0; j < o.values.length; j++) {
        const v = o.values[j]!;
        if (seenValueRefs.has(v.ref)) {
          ctx.addIssue({
            code: "custom",
            path: ["options", i, "values", j, "ref"],
            message: "option_value_ref_duplicate",
          });
        }
        seenValueRefs.add(v.ref);
      }
    }

    // 3 / 4 / 5. variant tuple shape + ref resolution + dup-tuple check.
    // Build a per-option-position map: option ref name + valid value refs.
    const optionByPosition: Array<{
      ref: string;
      valueRefs: Set<string>;
    }> = input.options.map((o) => ({
      ref: o.ref,
      valueRefs: new Set(o.values.map((v) => v.ref)),
    }));

    if (input.options.length === 0) {
      // Single-default mode: ≤ 1 empty-tuple variant allowed.
      const emptyTupleVariants = input.variants.filter(
        (v) => v.optionValueRefs.length === 0,
      );
      if (emptyTupleVariants.length > 1) {
        ctx.addIssue({
          code: "custom",
          path: ["variants"],
          message: "default_variant_required",
        });
      }
      // A non-empty tuple with no options is also a length mismatch:
      for (let vi = 0; vi < input.variants.length; vi++) {
        const v = input.variants[vi]!;
        if (v.optionValueRefs.length !== 0) {
          ctx.addIssue({
            code: "custom",
            path: ["variants", vi, "optionValueRefs"],
            message: "variant_option_value_refs_length_mismatch",
          });
        }
      }
    } else {
      for (let vi = 0; vi < input.variants.length; vi++) {
        const v = input.variants[vi]!;
        if (v.optionValueRefs.length !== input.options.length) {
          ctx.addIssue({
            code: "custom",
            path: ["variants", vi, "optionValueRefs"],
            message: "variant_option_value_refs_length_mismatch",
          });
          continue;
        }
        for (let pos = 0; pos < v.optionValueRefs.length; pos++) {
          const compound = v.optionValueRefs[pos]!;
          const colon = compound.indexOf(":");
          const optRef = colon >= 0 ? compound.slice(0, colon) : "";
          const valRef = colon >= 0 ? compound.slice(colon + 1) : "";
          const expected = optionByPosition[pos]!;
          if (optRef !== expected.ref) {
            ctx.addIssue({
              code: "custom",
              path: ["variants", vi, "optionValueRefs", pos],
              message: "option_value_ref_wrong_option",
            });
            continue;
          }
          if (!expected.valueRefs.has(valRef)) {
            ctx.addIssue({
              code: "custom",
              path: ["variants", vi, "optionValueRefs", pos],
              message: "option_value_ref_unknown",
            });
          }
        }
      }
    }

    // Duplicate-tuple check on the raw refs (call-scoped strings).
    // `[a, b]` vs `[b, a]` are distinct because position is significant.
    const seenTuples = new Set<string>();
    for (let vi = 0; vi < input.variants.length; vi++) {
      const v = input.variants[vi]!;
      // ASCII unit separator joiner — uuids/refs cannot contain it.
      const key = v.optionValueRefs.join("\x1f");
      if (seenTuples.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["variants", vi, "optionValueRefs"],
          message: "duplicate_variant_combination",
        });
      }
      seenTuples.add(key);
    }
  },
);

export type CreateProductRichInput = z.input<typeof CreateProductRichInputSchema>;
export type CreateProductRichInputParsed = z.output<
  typeof CreateProductRichInputSchema
>;

/**
 * One option result row from the live `setProductOptions` service —
 * server-minted UUIDs and positions, sorted in the same order as input.
 * We accept a structurally-typed shape so this module stays test-friendly
 * (no DB import) and decoupled from the service module's exact result
 * type. The fields used here match `OptionRef` from
 * `set-product-options.ts`.
 */
export interface OptionResultLike {
  id: string;
  name: { en: string; ar: string };
  position: number;
  values: Array<{
    id: string;
    value: { en: string; ar: string };
    position: number;
  }>;
}

/**
 * Resolved variant shape — the exact field set `SetProductVariantsInput`
 * expects, minus the `id` (always undefined for greenfield create).
 */
export interface ResolvedVariantInput {
  sku: string;
  priceMinor: number;
  currency: string;
  stock: number;
  active: boolean;
  optionValueIds: string[];
}

export interface RefMaps {
  /** option ref → server-minted option UUID */
  options: Record<string, string>;
  /** "<optionRef>:<valueRef>" → server-minted value UUID */
  optionValues: Record<string, string>;
}

/**
 * Build the option-ref → UUID and `<optionRef>:<valueRef>` → UUID maps
 * by zipping the parsed input's options against the live service result
 * IN INPUT ORDER. The service preserves input order, so positional
 * pairing is correct.
 */
export function buildRefMaps(
  parsed: CreateProductRichInputParsed,
  optionsResult: ReadonlyArray<OptionResultLike>,
): RefMaps {
  const options: Record<string, string> = {};
  const optionValues: Record<string, string> = {};
  if (parsed.options.length !== optionsResult.length) {
    // Defensive: should never happen — the composed handler only calls
    // this after writing the same options array. Throw a typed error so
    // a future service-shape drift fails loud, not silent.
    throw new Error(
      "rich-create refMap: options length mismatch (input vs result)",
    );
  }
  for (let i = 0; i < parsed.options.length; i++) {
    const inputOpt = parsed.options[i]!;
    const resultOpt = optionsResult[i]!;
    options[inputOpt.ref] = resultOpt.id;
    if (inputOpt.values.length !== resultOpt.values.length) {
      throw new Error(
        "rich-create refMap: values length mismatch on option",
      );
    }
    for (let j = 0; j < inputOpt.values.length; j++) {
      const ivref = inputOpt.values[j]!.ref;
      const rid = resultOpt.values[j]!.id;
      optionValues[`${inputOpt.ref}:${ivref}`] = rid;
    }
  }
  return { options, optionValues };
}

function sarToHalalas(sar: number): number {
  return Math.round(sar * 100);
}

/**
 * Convert ref-shaped variant inputs into the UUID-shaped variant inputs
 * the existing `setProductVariants` service expects. The caller has
 * already built the ref maps (after writing options) and passes them
 * in — this avoids walking the options tree twice.
 */
export function resolveRichVariants(
  parsed: CreateProductRichInputParsed,
  refMap: RefMaps,
): ResolvedVariantInput[] {
  const { optionValues } = refMap;
  return parsed.variants.map((v) => {
    const optionValueIds = v.optionValueRefs.map((compound) => {
      const id = optionValues[compound];
      if (id === undefined) {
        // Defensive: superRefine has already validated each compound ref
        // resolves to an option/value pair; reaching here means the
        // service returned mismatched data. Typed throw, not a leak.
        throw new Error(
          "rich-create resolveRichVariants: ref unresolved after refinement",
        );
      }
      return id;
    });
    return {
      sku: v.sku,
      priceMinor: sarToHalalas(v.priceSar),
      currency: v.currency,
      stock: v.stock,
      active: v.active,
      optionValueIds,
    };
  });
}
