/**
 * Bounded audit snapshots for `setProductOptions` / `setProductVariants`
 * (chunk 1a.5.1, spec §7).
 *
 * The wire return for these services keeps full materialised rows; the
 * append-only audit chain takes a `{count, ids, hash}`-style summary so:
 *   - audit_log row size doesn't scale with catalog size (the chain has
 *     a 64KB-per-row cap; 100 variants × full content easily blows it).
 *   - localized name/value JSONB never lands in PDPL-undeletable storage.
 *   - operator-readable text (variant SKUs) stays out of the chain too,
 *     mirroring the 1a.4.3 precedent (`hardDeleteExpiredCategories` holds
 *     slugs out of audit even though slugs are operator-readable). The
 *     audit chain records what action was taken by whom, not full
 *     point-in-time state.
 *   - investigators can verify "did this set change?" via `hash` and
 *     "what changed?" via the id lists.
 *
 * `hash` is SHA-256 truncated to 32 hex chars / 128 bits. The longer
 * truncation is a forensic-correlation safety knob: at 64 bits the
 * birthday bound sits at ~2^32 ≈ 4 billion writes; 128 bits removes the
 * question for any plausible tenant scale. Hash-equality is evidence,
 * not proof, of payload-equality.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/canonical-json";

/**
 * SHA-256 over a canonical-JSON-serialized value, truncated to 32 hex
 * chars (128 bits). Canonical JSON gives stable key ordering so the
 * hash is insensitive to object-property iteration order.
 */
function shortHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")
    .slice(0, 32);
}

export interface OptionsAuditInput {
  productId: string;
  options: ReadonlyArray<{
    id: string;
    position: number;
    values: ReadonlyArray<{
      id: string;
      position: number;
    }>;
  }>;
}

export interface OptionsAuditSnapshot {
  productId: string;
  optionsCount: number;
  optionIds: string[];
  valuesCount: number;
  valueIds: string[];
  hash: string;
}

export function buildOptionsAuditSnapshot(
  input: OptionsAuditInput,
): OptionsAuditSnapshot {
  const optionIds = input.options.map((o) => o.id).sort();
  const valueIds = input.options
    .flatMap((o) => o.values.map((v) => v.id))
    .sort();
  const valuesCount = valueIds.length;
  // Hash payload: positions + value sets keyed by option id (sorted).
  // Localized text intentionally excluded.
  const hashPayload = [...input.options]
    .map((o) => ({
      id: o.id,
      position: o.position,
      valueIds: o.values.map((v) => v.id).sort(),
      valuePositions: [...o.values]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((v) => v.position),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    productId: input.productId,
    optionsCount: input.options.length,
    optionIds,
    valuesCount,
    valueIds,
    hash: shortHash({ productId: input.productId, options: hashPayload }),
  };
}

export interface VariantsAuditInput {
  productId: string;
  variants: ReadonlyArray<{
    id: string;
    sku: string;
    priceMinor: number;
    currency: string;
    stock: number;
    active: boolean;
    optionValueIds: readonly string[];
  }>;
}

export interface VariantsAuditSnapshot {
  productId: string;
  count: number;
  ids: string[];
  hash: string;
}

export function buildVariantsAuditSnapshot(
  input: VariantsAuditInput,
): VariantsAuditSnapshot {
  const ids = input.variants.map((v) => v.id).sort();
  // SKUs are EXCLUDED from the snapshot output (the snapshot is what
  // crosses into the append-only audit chain). They DO go into the hash
  // payload — investigators can detect a SKU change via hash inequality
  // even though the chain itself never stores the SKU strings.
  const hashPayload = [...input.variants]
    .map((v) => ({
      id: v.id,
      sku: v.sku,
      priceMinor: v.priceMinor,
      currency: v.currency,
      stock: v.stock,
      active: v.active,
      optionValueIds: [...v.optionValueIds].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    productId: input.productId,
    count: input.variants.length,
    ids,
    hash: shortHash({ productId: input.productId, variants: hashPayload }),
  };
}
