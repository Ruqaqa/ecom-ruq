/**
 * Pure helpers for the variants admin UX (chunk 1a.5.2).
 *
 * `buildVariantRows` materialises the cartesian product of option values
 * in option-position order, then merges any currently-persisted variant
 * row by tuple-equality so SKU / price / stock / id survive a re-open.
 *
 * `formatCombinationLabel` returns the row's user-visible label for the
 * Variants list (Screen 2). It joins option-name : value-name pairs in
 * option-position order with ` · ` (LTR — under RTL the bidi-isolation
 * on each token does the right thing visually).
 *
 * `variantRowKey` is a stable, sort-invariant fingerprint of the
 * value-id tuple. It powers the row's `data-testid="variant-row"` /
 * `data-key=...` selector and the in-memory dedupe set used when the
 * options tree changes (Screen 3 transitions).
 *
 * No React, no DOM, no I/O. Three reasons this lives in `src/lib`:
 * - The cartesian generator is the single source of truth for what a
 *   variant row represents — the Playwright spec uses the same key
 *   shape as the form does, so a regression in either side is caught
 *   end-to-end.
 * - The merge-by-tuple invariant is what protects the operator's
 *   in-flight SKU / price / stock when they tweak the options tree
 *   mid-edit (Screen 3 State B / D); we want to test it without
 *   mounting React.
 * - Bulk-apply (1a.5.3) will reuse `variantRowKey` to identify the
 *   selected rows; centralising the helper now keeps that work small.
 */
import type { LocalizedText } from "@/lib/i18n/localized";

export interface EditorOptionValue {
  id: string;
  value: LocalizedText;
  position: number;
}

export interface EditorOption {
  id: string;
  name: LocalizedText;
  position: number;
  values: EditorOptionValue[];
}

export interface EditorVariant {
  id?: string | undefined;
  sku: string;
  priceMinor: number;
  currency: string;
  stock: number;
  active: boolean;
  optionValueIds: string[];
}

export interface VariantRow {
  /** Persisted variant id when one already existed for this tuple, else undefined. */
  id: string | undefined;
  /** Stable, sort-invariant fingerprint used as the row's data-key and React key. */
  key: string;
  /** Ordered tuple of option-value ids — matches the option-position order. */
  tuple: string[];
  sku: string;
  /** Null when the row is brand new and has no SKU/price/stock yet. */
  priceMinor: number | null;
  currency: string;
  stock: number | null;
  active: boolean;
}

/**
 * Stable fingerprint for a tuple. The join character is `:` (uuid
 * grammar excludes it, so the fingerprint is unambiguous) and ids are
 * sorted lexically before joining so two orderings of the same set
 * collide — matches the Set-of-tuples uniqueness invariant the back
 * office enforces in `setProductVariants`.
 *
 * The empty tuple maps to the literal `default` so single-variant mode
 * has a stable selector.
 *
 * Contract is load-bearing for 1a.5.3 (the bulk-apply sheet selects
 * variant rows by this key, and the cascade-warning dialog identifies
 * the rows that will be hard-deleted by it). DO NOT add a fast-path —
 * single-option products must still emit the full tuple, never a
 * shortened form. Sort is by id, never by display name (locale-
 * dependent). The `default` literal is reserved for flat-form mode.
 */
export function variantRowKey(tuple: ReadonlyArray<string>): string {
  if (tuple.length === 0) return "default";
  return [...tuple].sort().join(":");
}

/**
 * Materialise the cartesian product of options × values in option-
 * position order, merging any existing variant rows by tuple-equality.
 *
 * If `options` is empty, returns exactly one row (the default-variant
 * mode). Existing variant rows whose tuple is empty hydrate the
 * default row; this is what enables the Screen 3 State C transition
 * back to the flat form without losing data.
 */
export function buildVariantRows(
  options: ReadonlyArray<EditorOption>,
  existing: ReadonlyArray<EditorVariant>,
): VariantRow[] {
  const existingByKey = new Map<string, EditorVariant>();
  for (const v of existing) {
    existingByKey.set(variantRowKey(v.optionValueIds), v);
  }

  if (options.length === 0) {
    const match = existingByKey.get("default");
    return [makeRow([], match)];
  }

  const sortedOptions = [...options].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
  const orderedValueIdsPerOption = sortedOptions.map((o) =>
    [...o.values]
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((v) => v.id),
  );

  const tuples: string[][] = [[]];
  for (const valueIds of orderedValueIdsPerOption) {
    const next: string[][] = [];
    for (const t of tuples) {
      for (const v of valueIds) next.push([...t, v]);
    }
    tuples.length = 0;
    tuples.push(...next);
  }

  return tuples.map((t) => makeRow(t, existingByKey.get(variantRowKey(t))));
}

function makeRow(tuple: string[], match: EditorVariant | undefined): VariantRow {
  return {
    id: match?.id,
    key: variantRowKey(tuple),
    tuple,
    sku: match?.sku ?? "",
    priceMinor: match?.priceMinor ?? null,
    currency: match?.currency ?? "SAR",
    stock: match?.stock ?? null,
    active: match?.active ?? true,
  };
}

/**
 * Render the row's combination label as `Option: Value · Option: Value`.
 * Returns the empty string for the default tuple (single-variant mode).
 *
 * The locale is the *display* locale; both option names and value
 * names are looked up in that locale. Falling back to the other
 * locale when one side is missing is the storefront's job (CLAUDE.md
 * §4 — admin UI surfaces missing translations explicitly), so this
 * helper does not hide missing-translation state.
 */
export function formatCombinationLabel(
  tuple: ReadonlyArray<string>,
  options: ReadonlyArray<EditorOption>,
  locale: "en" | "ar",
): string {
  if (tuple.length === 0) return "";
  const sortedOptions = [...options].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
  const valueIndex = new Map<string, EditorOptionValue>();
  for (const o of sortedOptions) {
    for (const v of o.values) valueIndex.set(v.id, v);
  }
  const parts: string[] = [];
  for (let i = 0; i < sortedOptions.length; i++) {
    const opt = sortedOptions[i]!;
    const valueId = tuple[i];
    if (valueId === undefined) continue;
    const v = valueIndex.get(valueId);
    if (!v) continue;
    parts.push(`${opt.name[locale]}: ${v.value[locale]}`);
  }
  return parts.join(" · ");
}
