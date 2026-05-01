/**
 * `getProductWithVariants` — composite read for the admin product edit
 * page (chunk 1a.5.1).
 *
 * Three queries, no N+1:
 *   1. SELECT on `products` (role-gated column list — Tier-B owner sees
 *      `costPriceMinor`, staff does not). Mirrors `getProduct`.
 *   2. SELECT on `product_options` LEFT JOIN `product_option_values`,
 *      filtered by tenant + product. Materialises the nested array.
 *   3. SELECT on `product_variants` filtered by tenant + product.
 *
 * Returns `null` when the product doesn't resolve (phantom uuid /
 * cross-tenant probe / soft-deleted absent the includeDeleted flag).
 * The opaque shape is the existence-leak guard.
 */
import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  productOptions,
  productOptionValues,
  productVariants,
  products,
} from "@/server/db/schema/catalog";
import {
  ProductOwnerSchema,
  ProductPublicSchema,
  type ProductOwner,
  type ProductPublic,
} from "@/server/services/products/create-product";
import type { Tx } from "@/server/db";
import { isWriteRole, type Role } from "@/server/tenant/context";
import type { LocalizedText } from "@/lib/i18n/localized";

export interface GetProductWithVariantsTenantInfo {
  id: string;
}

export const GetProductWithVariantsInputSchema = z.object({
  id: z.string().uuid(),
  includeDeleted: z.boolean().default(false),
});
export type GetProductWithVariantsInput = z.input<
  typeof GetProductWithVariantsInputSchema
>;

export interface OptionWithValues {
  id: string;
  name: LocalizedText;
  position: number;
  values: Array<{ id: string; value: LocalizedText; position: number }>;
}

export interface VariantRow {
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

export interface GetProductWithVariantsResult {
  product: ProductOwner | ProductPublic;
  options: OptionWithValues[];
  variants: VariantRow[];
}

export async function getProductWithVariants(
  tx: Tx,
  tenant: GetProductWithVariantsTenantInfo,
  role: Role,
  input: GetProductWithVariantsInput,
): Promise<GetProductWithVariantsResult | null> {
  const parsed = GetProductWithVariantsInputSchema.parse(input);
  if (parsed.includeDeleted && !isWriteRole(role)) {
    throw new Error(
      "getProductWithVariants: includeDeleted requires owner or staff role",
    );
  }

  const ownerRole = role === "owner";
  const baseSelect = {
    id: products.id,
    slug: products.slug,
    name: products.name,
    description: products.description,
    status: products.status,
    createdAt: products.createdAt,
    updatedAt: products.updatedAt,
    deletedAt: products.deletedAt,
  };
  const selectCols = ownerRole
    ? { ...baseSelect, costPriceMinor: products.costPriceMinor }
    : baseSelect;

  const filters = [
    eq(products.id, parsed.id),
    eq(products.tenantId, tenant.id),
  ];
  if (!parsed.includeDeleted) filters.push(isNull(products.deletedAt));

  const productRows = await tx
    .select(selectCols)
    .from(products)
    .where(and(...filters))
    .limit(1);
  const productRow = productRows[0];
  if (!productRow) return null;

  const productParsed = ownerRole
    ? ProductOwnerSchema.parse(productRow)
    : ProductPublicSchema.parse(productRow);

  // Options + values via LEFT JOIN. One round-trip; the row count is
  // bounded (≤3 options × ≤100 values = 300 rows).
  const optionRows = await tx
    .select({
      optionId: productOptions.id,
      optionName: productOptions.name,
      optionPosition: productOptions.position,
      valueId: productOptionValues.id,
      valueValue: productOptionValues.value,
      valuePosition: productOptionValues.position,
    })
    .from(productOptions)
    .leftJoin(
      productOptionValues,
      and(
        eq(productOptionValues.optionId, productOptions.id),
        eq(productOptionValues.tenantId, productOptions.tenantId),
      ),
    )
    .where(
      and(
        eq(productOptions.tenantId, tenant.id),
        eq(productOptions.productId, parsed.id),
      ),
    )
    .orderBy(
      asc(productOptions.position),
      asc(productOptions.id),
      asc(productOptionValues.position),
      asc(productOptionValues.id),
    );

  const optionsByOptionId = new Map<string, OptionWithValues>();
  for (const r of optionRows) {
    let opt = optionsByOptionId.get(r.optionId);
    if (!opt) {
      opt = {
        id: r.optionId,
        name: r.optionName as LocalizedText,
        position: r.optionPosition,
        values: [],
      };
      optionsByOptionId.set(r.optionId, opt);
    }
    if (r.valueId !== null) {
      opt.values.push({
        id: r.valueId,
        value: r.valueValue as LocalizedText,
        position: r.valuePosition!,
      });
    }
  }
  const options: OptionWithValues[] = [...optionsByOptionId.values()].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );

  // Variants — separate query.
  const variantRows = (await tx
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
        eq(productVariants.productId, parsed.id),
      ),
    )
    .orderBy(
      asc(productVariants.createdAt),
      asc(productVariants.id),
    )) as VariantRow[];

  return {
    product: productParsed,
    options,
    variants: variantRows,
  };
}
