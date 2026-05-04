// Composite parent audit-after for the rich-create call. Each section
// is nullable: null means the input bag was empty. Reuses the existing
// bounded-snapshot helpers (ids + hashes only, no localized text) so
// composed and single-piece audit rows stay forensically uniform.
import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/canonical-json";
import {
  buildOptionsAuditAfterSnapshot,
  buildVariantsAuditSnapshot,
  type OptionsAuditAfterSnapshot,
  type VariantsAuditSnapshot,
} from "@/server/services/variants/audit-snapshot";

function shortHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")
    .slice(0, 32);
}

export interface CategoriesAuditSnapshot {
  productId: string;
  ids: string[];
  hash: string;
}

/**
 * `{ ids, hash }`-style snapshot for the categories attached to a
 * product. Mirrors the variants shape — investigators verify "did the
 * set change?" via hash and "what changed?" via ids.
 */
export function buildCategoriesAuditSnapshot(input: {
  productId: string;
  categoryIds: ReadonlyArray<string>;
}): CategoriesAuditSnapshot {
  const ids = [...input.categoryIds].sort();
  return {
    productId: input.productId,
    ids,
    hash: shortHash({ productId: input.productId, ids }),
  };
}

export interface RichCreateAuditAfter {
  productId: string;
  options: OptionsAuditAfterSnapshot | null;
  variants: VariantsAuditSnapshot | null;
  categories: CategoriesAuditSnapshot | null;
}

export interface RichCreateAuditAfterInput {
  productId: string;
  options?:
    | ReadonlyArray<{
        id: string;
        position: number;
        values: ReadonlyArray<{ id: string; position: number }>;
      }>
    | undefined;
  variants?:
    | ReadonlyArray<{
        id: string;
        sku: string;
        priceMinor: number;
        currency: string;
        stock: number;
        active: boolean;
        optionValueIds: ReadonlyArray<string>;
      }>
    | undefined;
  categoryIds?: ReadonlyArray<string> | undefined;
}

/**
 * Compose the composite `after` payload. Each section is null when its
 * input is omitted or empty — investigators reading the chain can tell
 * "no options were written" from "options were written but empty" only
 * if we keep this contract clean.
 *
 * For greenfield create the cascade list on options is always empty
 * (no pre-existing variants to cascade-delete).
 */
export function buildRichCreateAuditAfter(
  input: RichCreateAuditAfterInput,
): RichCreateAuditAfter {
  const options =
    input.options && input.options.length > 0
      ? buildOptionsAuditAfterSnapshot(
          { productId: input.productId, options: input.options },
          [],
        )
      : null;

  const variants =
    input.variants && input.variants.length > 0
      ? buildVariantsAuditSnapshot({
          productId: input.productId,
          variants: input.variants,
        })
      : null;

  const categories =
    input.categoryIds && input.categoryIds.length > 0
      ? buildCategoriesAuditSnapshot({
          productId: input.productId,
          categoryIds: input.categoryIds,
        })
      : null;

  return {
    productId: input.productId,
    options,
    variants,
    categories,
  };
}
