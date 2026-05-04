/**
 * `create_product_rich` — composed product creation MCP tool
 * (architect Block 4).
 *
 * The MCP-seam `.strict()` wrapper around the composed
 * `createProductRich` service. Mirrors the visibility / authorize /
 * description shape of the single-piece `create_product` tool:
 *
 *   - `auditMode:"mutation"` (registered in registry.ts) — dispatchTool
 *     runs through `runWithAudit` so the parent `mcp.create_product_rich`
 *     audit row is written in-tx on success.
 *   - bearer + `isWriteRole` gate; tools/list never advertises this
 *     tool to support / customer / anonymous identities.
 *
 * Dry-run handling — the architect's spec says: "throw a sentinel
 * `DryRunRollback` error after step 4 (with the assembled output
 * cached on the error). The orchestrator catches it, treats as success
 * on the wire, but the tx rolls back. Do not record a success audit
 * row for a dry-run; record an `outcome:'success'` audit row with
 * `operation:'mcp.create_product_rich.dry_run'` written in its own
 * follow-up tx after rollback."
 *
 * The dispatcher's mutation flow uses `runWithAudit`'s
 * `isExpectedRollback` hook so the failure-audit row that would
 * otherwise be written for the `DryRunRollback` throw is suppressed.
 * This module's handler then catches the sentinel and writes the
 * `.dry_run` success row in its own follow-up tx via
 * `writeAuditInOwnTx`.
 *
 * Race / failure note (orchestrator clarification §2):
 *   The dry-run audit row is written AFTER rollback. If that follow-up
 *   tx fails (DB connection drop between rollback and follow-up), the
 *   call returns a previewed shape on the wire with no audit trace.
 *   `writeAuditInOwnTx` already captures `audit_write_failure` in
 *   Sentry on its own throw, so the race is observable in production.
 *   Documented here rather than tested with mocks because the cost of
 *   a contrived test (monkey-patching the appDb client) outweighs the
 *   value of exercising a one-in-a-million path.
 */
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
// (deletedAtIso, costPriceSar). Variants and options nested objects
// are carried as-is — the AI agent reads UUIDs from the refMap.
export const CreateProductRichMcpOutputSchema = z.object({
  product: z.union([ProductOwnerMcpSchema, ProductPublicMcpSchema]),
  options: z.array(z.unknown()),
  variants: z.array(z.unknown()),
  categories: z.array(z.unknown()),
  refMap: z.object({
    options: z.record(z.string(), z.string()),
    optionValues: z.record(z.string(), z.string()),
  }),
  dryRun: z.boolean(),
});
export type CreateProductRichMcpOutput = CreateProductRichResult;

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
    return result;
  },
};

/**
 * The dispatcher uses this to recognize the rich-create's dry-run
 * sentinel and treat it as a successful no-op (rolled-back tx,
 * preview returned to wire). Exported so the dispatcher can branch on
 * it without importing the service module.
 */
export function isRichCreateDryRunRollback(err: unknown): err is DryRunRollback {
  return err instanceof DryRunRollback;
}
