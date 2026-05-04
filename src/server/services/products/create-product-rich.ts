/**
 * `createProductRich` — composed all-or-nothing product creation
 * (architect Block 3).
 *
 * Composes the four existing service primitives — `createProduct`,
 * `setProductOptions`, `setProductVariants`, `setProductCategories` —
 * into one operation under a single `withTenant` transaction. Each
 * primitive still owns its OCC, advisory locks, FOR SHARE locks, and
 * closed-set wire errors. The composed handler:
 *
 *   1. invokes `createProduct` with the basic product fields
 *   2. if input.options is non-empty, calls `setProductOptions` and
 *      builds the ref → UUID map
 *   3. if input.variants is non-empty, resolves the call-scoped refs
 *      to UUIDs (and SAR → halalas), then calls `setProductVariants`
 *   4. if input.categoryIds is non-empty, calls `setProductCategories`
 *   5. assembles the wire output (MCP shapes) and the bounded
 *      audit-after payload, and either returns it (real run) or throws
 *      a sentinel `DryRunRollback` (rolls back the tx, the MCP handler
 *      catches and presents the assembled output)
 *
 * `expectedUpdatedAt` is threaded forward between steps using whatever
 * timestamp the previous step returned. Each step bumps the product
 * row's `updated_at`, so the chain stays correct without any extra
 * SELECT.
 *
 * Tenant invariants the service preserves:
 *   - tenant id flows from the typed `tenant` argument; `input` never
 *     carries it (the schema is `.strict()` and has no `tenantId` field).
 *   - cross-tenant `categoryIds` are rejected by the existing
 *     `setProductCategories` FOR SHARE existence check. The composed
 *     handler does NOT pre-read categories itself.
 *
 * Audit shape (for the MCP adapter to record):
 *   - one parent audit row, `operation: "mcp.create_product_rich"`
 *   - `before: null` (greenfield)
 *   - `after`: composite of the existing bounded snapshots — see
 *     `rich-create-audit.ts`. Localized text never crosses.
 *   - `dryRun: true` writes `mcp.create_product_rich.dry_run` AFTER
 *     rollback in a separate tx (the MCP adapter does this — see the
 *     handler in `src/server/mcp/tools/create-product-rich.ts`).
 *
 * Race / failure note (orchestrator clarification §2):
 *   The dry-run audit row is written in a follow-up tx AFTER the main
 *   tx rolls back. If the follow-up tx fails (DB connection drop
 *   between rollback and follow-up), the dry-run call returns the
 *   previewed shape on the wire with no audit trace. We chose to
 *   document this race here rather than add a contrived test for a
 *   one-in-a-million path; the MCP handler's `writeAuditInOwnTx` path
 *   already captures `audit_write_failure` in Sentry on its own throw,
 *   so the race is observable in production.
 */
import { z } from "zod";
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
  ProductOwnerMcpSchema,
  ProductPublicMcpSchema,
  productToMcpShape,
  type ProductOwnerMcp,
  type ProductPublicMcp,
} from "@/server/mcp/tools/_product-shapes";
import type { OptionRef } from "@/server/services/variants/set-product-options";
import type { ProductCategoryRef } from "./set-product-categories";
import type { Tx } from "@/server/db";
import type { Role } from "@/server/tenant/context";

export interface CreateProductRichTenantInfo {
  id: string;
  defaultLocale: "en" | "ar";
}

/** Variant shape on the wire — MCP-flavored: SAR not halalas. */
const VariantRichSchema = z.object({
  id: z.string().uuid(),
  sku: z.string(),
  priceSar: z.number().nonnegative(),
  currency: z.string(),
  stock: z.number().int().nonnegative(),
  active: z.boolean(),
  optionValueIds: z.array(z.string().uuid()),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type VariantRich = z.infer<typeof VariantRichSchema>;

/** Output schema — MCP-flavored shapes for the rich-create call. */
export const CreateProductRichOutputSchema = z.object({
  product: z.union([ProductOwnerMcpSchema, ProductPublicMcpSchema]),
  options: z.array(z.unknown()), // OptionRefSchema (re-exported from variants service)
  variants: z.array(VariantRichSchema),
  categories: z.array(z.unknown()),
  refMap: z.object({
    options: z.record(z.string(), z.string().uuid()),
    optionValues: z.record(z.string(), z.string().uuid()),
  }),
  dryRun: z.boolean(),
});

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

/**
 * Sentinel thrown after the assembled output is computed when
 * `dryRun: true`. The composed handler throws this from inside the tx
 * so the tx rolls back and nothing persists. The MCP tool catches it,
 * records `mcp.create_product_rich.dry_run` in a follow-up tx, and
 * returns the preview to the wire. Service callers that want a different
 * surface can also catch it directly.
 *
 * Important: the audit dispatcher's `isExpectedRollback` predicate
 * silently suppresses the failure-audit row when this error class
 * propagates. Construct it ONLY from the dry-run branch — leaking it
 * from any other path would lose a real failure-audit record.
 */
export class DryRunRollback extends Error {
  public readonly dryRunRollback = true as const;
  constructor(public readonly preview: CreateProductRichResult) {
    super("dry_run_rollback");
    this.name = "DryRunRollback";
  }
}

function isParsedAlreadyParsed(
  v: unknown,
): v is CreateProductRichInputParsed {
  return (
    typeof v === "object" &&
    v !== null &&
    "options" in v &&
    Array.isArray((v as { options: unknown }).options)
  );
}

function reTryParse(input: unknown): CreateProductRichInputParsed {
  // The service is the source of truth for the parse — even if the
  // caller already parsed (e.g. the MCP adapter), we re-parse here as
  // a defense-in-depth (matches the createProduct shape — see its
  // module docstring rule 5).
  return CreateProductRichInputSchema.parse(input) as CreateProductRichInputParsed;
}

export async function createProductRich(
  tx: Tx,
  tenant: CreateProductRichTenantInfo,
  role: Role,
  input: unknown,
): Promise<CreateProductRichResult> {
  const parsed: CreateProductRichInputParsed = isParsedAlreadyParsed(input)
    ? reTryParse(input)
    : reTryParse(input);

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

  // 3. Variants (if any).
  let variantsResult: VariantRich[] = [];
  if (parsed.variants.length > 0) {
    const resolvedVariants = resolveRichVariants(parsed, optionsResult);
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
    variantsResult = variantsCall.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      // Service stores halalas; wire returns SAR (decimal riyals).
      priceSar: v.priceMinor / 100,
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
        ? variantsResult.map((v) => ({
            id: v.id,
            sku: v.sku,
            priceMinor: Math.round(v.priceSar * 100),
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
