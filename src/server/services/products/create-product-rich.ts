// Dry-run race (documented, not tested): the dry-run audit row is
// written in a follow-up tx AFTER the main tx rolls back. If the
// follow-up tx fails (DB connection drop in the gap), the dry-run
// returns the preview on the wire with no audit trace. The follow-up
// path captures `audit_write_failure` in Sentry, so the race is
// observable. Acceptable because the dry-run persisted nothing; a real
// success cannot lose its audit row (that write is in-tx).
import { createProduct } from "./create-product";
import { setProductOptions } from "@/server/services/variants/set-product-options";
import { setProductVariants } from "@/server/services/variants/set-product-variants";
import { setProductCategories } from "./set-product-categories";
import {
  CreateProductRichInputSchema,
  resolveRichVariants,
  buildRefMaps,
  type CreateProductRichInputParsed,
  type RefMaps,
} from "./rich-create-refs";
import {
  buildRichCreateAuditAfter,
  type RichCreateAuditAfter,
} from "./rich-create-audit";
import {
  productToMcpShape,
  type ProductOwnerMcp,
  type ProductPublicMcp,
} from "@/server/mcp/tools/_product-shapes";
import type { OptionRef } from "@/server/services/variants/set-product-options";
import type { VariantRef } from "@/server/services/variants/set-product-variants";
import type { ProductCategoryRef } from "./set-product-categories";
import type { Tx } from "@/server/db";
import type { Role } from "@/server/tenant/context";

export interface CreateProductRichTenantInfo {
  id: string;
  defaultLocale: "en" | "ar";
}

// Variant shape returned by the service — transport-neutral: halalas
// (the storage unit). The MCP tool layer converts to SAR for the wire.
export interface VariantRich {
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

/** Wire shape returned by the service. Service-internal — exported so
 *  the MCP tool can declare the same type. */
export interface CreateProductRichResult {
  product: ProductOwnerMcp | ProductPublicMcp;
  options: OptionRef[];
  variants: VariantRich[];
  categories: ProductCategoryRef[];
  refMap: RefMaps;
  dryRun: boolean;
  /**
   * Composite audit `after` payload. Service computes it; the MCP tool
   * forwards it via `ctx.auditOverride.after` so the parent audit row
   * carries the bounded snapshots instead of the wire return.
   */
  auditAfter: RichCreateAuditAfter;
}

// The dispatcher's `isExpectedRollback` predicate silently suppresses
// the failure-audit row whenever this class propagates. Construct it
// ONLY from the dry-run branch — leaking it from any other path would
// lose a real failure-audit record.
//
// `preview` is typed as a structural carrier (just `auditAfter` is
// load-bearing for the dispatcher's follow-up audit row). The tool
// handler may rethrow with a wire-shape preview after applying its
// transport conversion; the service stays transport-neutral.
export interface DryRunRollbackPreview {
  auditAfter: RichCreateAuditAfter;
}

export class DryRunRollback<P extends DryRunRollbackPreview = CreateProductRichResult> extends Error {
  public readonly dryRunRollback = true as const;
  constructor(public readonly preview: P) {
    super("dry_run_rollback");
    this.name = "DryRunRollback";
  }
}

export async function createProductRich(
  tx: Tx,
  tenant: CreateProductRichTenantInfo,
  role: Role,
  input: unknown,
): Promise<CreateProductRichResult> {
  const parsed = CreateProductRichInputSchema.parse(
    input,
  ) as CreateProductRichInputParsed;

  // 1. Create the product row.
  const productRow = await createProduct(
    tx,
    { id: tenant.id, defaultLocale: tenant.defaultLocale },
    role,
    {
      slug: parsed.slug,
      name: parsed.name,
      description: parsed.description,
      status: parsed.status,
    },
  );

  let lastUpdatedAt: Date = productRow.updatedAt;
  let optionsResult: OptionRef[] = [];
  let refMap: RefMaps = { options: {}, optionValues: {} };

  // 2. Options (if any).
  if (parsed.options.length > 0) {
    const optsCall = await setProductOptions(
      tx,
      { id: tenant.id },
      role,
      {
        productId: productRow.id,
        expectedUpdatedAt: lastUpdatedAt.toISOString(),
        options: parsed.options.map((o) => ({
          name: o.name,
          values: o.values.map((v) => ({ value: v.value })),
        })),
      },
    );
    optionsResult = optsCall.options;
    lastUpdatedAt = optsCall.productUpdatedAt;
    refMap = buildRefMaps(parsed, optionsResult);
  }

  // 3. Variants (if any). Keep the canonical halalas-shape from the
  //    underlying service for the audit-after rebuild; convert to SAR
  //    only for the wire result below.
  let variantsCanonical: VariantRef[] = [];
  let variantsResult: VariantRich[] = [];
  if (parsed.variants.length > 0) {
    const resolvedVariants = resolveRichVariants(parsed, refMap);
    const variantsCall = await setProductVariants(
      tx,
      { id: tenant.id },
      role,
      {
        productId: productRow.id,
        expectedUpdatedAt: lastUpdatedAt.toISOString(),
        variants: resolvedVariants,
      },
    );
    lastUpdatedAt = variantsCall.productUpdatedAt;
    variantsCanonical = variantsCall.variants;
    variantsResult = variantsCall.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      priceMinor: v.priceMinor,
      currency: v.currency,
      stock: v.stock,
      active: v.active,
      optionValueIds: v.optionValueIds,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    }));
  }

  // 4. Categories (if any). The existing service's FOR SHARE existence
  //    check is the cross-tenant gate — we deliberately do NOT read
  //    categories ourselves here.
  let categoriesResult: ProductCategoryRef[] = [];
  if (parsed.categoryIds.length > 0) {
    const catsCall = await setProductCategories(
      tx,
      { id: tenant.id },
      role,
      {
        productId: productRow.id,
        expectedUpdatedAt: lastUpdatedAt.toISOString(),
        categoryIds: parsed.categoryIds,
      },
    );
    categoriesResult = catsCall.after.categories;
    lastUpdatedAt = catsCall.productUpdatedAt;
  }

  // Refresh the product wire shape so its `updatedAt` reflects the
  // bumped value after options / variants / categories writes (each
  // call advances `updated_at`).
  const refreshedProduct: typeof productRow = {
    ...productRow,
    updatedAt: lastUpdatedAt,
  };

  const product = productToMcpShape(refreshedProduct);

  const auditAfter = buildRichCreateAuditAfter({
    productId: productRow.id,
    options:
      parsed.options.length > 0
        ? optionsResult.map((o) => ({
            id: o.id,
            position: o.position,
            values: o.values.map((v) => ({ id: v.id, position: v.position })),
          }))
        : undefined,
    variants:
      parsed.variants.length > 0
        ? variantsCanonical.map((v) => ({
            id: v.id,
            sku: v.sku,
            priceMinor: v.priceMinor,
            currency: v.currency,
            stock: v.stock,
            active: v.active,
            optionValueIds: v.optionValueIds,
          }))
        : undefined,
    categoryIds:
      parsed.categoryIds.length > 0 ? parsed.categoryIds : undefined,
  });

  const result: CreateProductRichResult = {
    product,
    options: optionsResult,
    variants: variantsResult,
    categories: categoriesResult,
    refMap,
    dryRun: parsed.dryRun,
    auditAfter,
  };

  // 5. dry-run sentinel — throws AFTER the full assembly so the preview
  //    matches the real call's shape, but BEFORE returning so the tx
  //    rolls back. The MCP adapter catches this and surfaces success.
  if (parsed.dryRun) {
    throw new DryRunRollback(result);
  }

  return result;
}
