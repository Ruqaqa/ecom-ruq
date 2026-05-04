// Dry-run flow: the service throws `DryRunRollback` after assembling
// the preview so the tx rolls back. The dispatcher's
// `isExpectedRollback` hook suppresses the would-be failure-audit row;
// this handler then catches the sentinel and writes the `.dry_run`
// success row in its own follow-up tx (the race in that follow-up is
// documented at the service module).
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  createProductRich,
  DryRunRollback,
  type CreateProductRichResult,
  type CreateProductRichTenantInfo,
} from "@/server/services/products/create-product-rich";
import {
  CreateProductRichInputSchema,
  type CreateProductRichInput,
} from "@/server/services/products/rich-create-refs";
import { isWriteRole } from "@/server/tenant/context";
import {
  ProductOwnerMcpSchema,
  ProductPublicMcpSchema,
} from "./_product-shapes";

// Surface MCP-seam .strict() wrapping. The underlying
// `CreateProductRichInputSchema` is already `.strict()` (it uses
// `baseSchema.strict()` then `superRefine`, which preserves the strict
// flag on the inner object).
export const CreateProductRichMcpInputSchema = CreateProductRichInputSchema;
export type CreateProductRichMcpInput = CreateProductRichInput;

// MCP wire output schema. The `options` / `categories` arrays carry
// service-shaped objects; the `product` is the MCP-flavored shape
// (deletedAtIso, costPriceSar). Variants are reshaped here from the
// service's halalas-shape into the MCP wire's SAR-shape.
const VariantWireSchema = z.object({
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
type VariantWire = z.infer<typeof VariantWireSchema>;

export const CreateProductRichMcpOutputSchema = z.object({
  product: z.union([ProductOwnerMcpSchema, ProductPublicMcpSchema]),
  options: z.array(z.unknown()),
  variants: z.array(VariantWireSchema),
  categories: z.array(z.unknown()),
  refMap: z.object({
    options: z.record(z.string(), z.string()),
    optionValues: z.record(z.string(), z.string()),
  }),
  dryRun: z.boolean(),
});
export type CreateProductRichMcpOutput = Omit<
  CreateProductRichResult,
  "variants"
> & {
  variants: VariantWire[];
};

const TOOL_DESCRIPTION = [
  "Create a product, its option types and values, its variants, and",
  "its category attachments in ONE all-or-nothing call. Either every",
  "piece is committed atomically in a single transaction, or none of",
  "it is. Use this when you have the full product structure ready in",
  "one shot. For incremental edits, use the single-piece tools",
  "(create_product, set_product_options, set_product_variants,",
  "set_product_categories).",
  "",
  "Local refs: the input lets you tag each option and value with a",
  "human-readable ref string (lowercase, digits, dash, underscore;",
  "max 32 chars), then refer to those refs from each variant in the",
  "form 'optionRef:valueRef'. Refs are call-scoped — they exist only",
  "inside this single input and are NEVER persisted. The response's",
  "refMap correlates each ref back to the server-minted UUID.",
  "",
  "Variant.optionValueRefs MUST list one ref per option type, in the",
  "SAME ORDER as input.options. If options is empty, variants must",
  "be empty or contain exactly one variant with an empty",
  "optionValueRefs array (single-default mode).",
  "",
  "Caps (Zod-enforced before the transaction opens): at most 3 option",
  "types per product, at most 100 values per option, at most 100",
  "variants per product, at most 32 categories per product. Prices",
  "are SAR (decimal riyals).",
  "",
  "dryRun: when true, the call validates and assembles the full",
  "output (including server-minted UUIDs) but rolls the transaction",
  "back so nothing persists. The returned shape is identical to a",
  "real call's output, just with dryRun: true. Use this to preview",
  "a complex create before committing.",
  "",
  "Owner or staff. Slug must be unique within the tenant; SKUs must",
  "be unique within the tenant.",
].join(" ");

export const createProductRichTool: McpTool<
  CreateProductRichMcpInput,
  CreateProductRichMcpOutput
> = {
  name: "create_product_rich",
  description: TOOL_DESCRIPTION,
  inputSchema:
    CreateProductRichMcpInputSchema as unknown as z.ZodType<CreateProductRichMcpInput>,
  outputSchema:
    CreateProductRichMcpOutputSchema as unknown as z.ZodType<CreateProductRichMcpOutput>,
  isVisibleFor(ctx) {
    if (ctx.identity.type !== "bearer") return false;
    return isWriteRole(ctx.identity.role);
  },
  authorize(ctx) {
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    if (!isWriteRole(ctx.identity.role)) {
      throw new McpError(
        "forbidden",
        "create_product_rich requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "create_product_rich dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const tenant: CreateProductRichTenantInfo = {
      id: ctx.tenant.id,
      defaultLocale: ctx.tenant.defaultLocale,
    };
    try {
      const result = await createProductRich(
        tx,
        tenant,
        ctx.identity.role,
        input,
      );
      // Composite audit `after` — the parent row records bounded
      // snapshots, not the wire shape.
      ctx.auditOverride.before = null;
      ctx.auditOverride.after = result.auditAfter;
      return toWire(result);
    } catch (err) {
      // Reshape the rolled-back preview into the wire shape so the
      // dispatcher returns a consistent variant shape on the dry-run
      // path. The rethrow keeps the rollback contract intact.
      if (err instanceof DryRunRollback) {
        throw new DryRunRollback(toWire(err.preview as CreateProductRichResult));
      }
      throw err;
    }
  },
};

function toWire(result: CreateProductRichResult): CreateProductRichMcpOutput {
  return {
    ...result,
    variants: result.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      priceSar: v.priceMinor / 100,
      currency: v.currency,
      stock: v.stock,
      active: v.active,
      optionValueIds: v.optionValueIds,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    })),
  };
}

/**
 * The dispatcher uses this to recognize the rich-create's dry-run
 * sentinel and treat it as a successful no-op (rolled-back tx,
 * preview returned to wire). Exported so the dispatcher can branch on
 * it without importing the service module.
 */
export function isRichCreateDryRunRollback(err: unknown): err is DryRunRollback {
  return err instanceof DryRunRollback;
}
