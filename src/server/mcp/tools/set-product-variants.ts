/**
 * `set_product_variants` — MCP mutation tool (chunk 1a.5.1).
 *
 * Mirrors `set_product_options`:
 *   - `auditMode:"mutation"` — runWithAudit owns the transaction.
 *   - Audit `before`/`after` are bounded snapshots (spec §7).
 *   - `.strict()` schema rejects adversarial extra keys.
 *
 * Tool description (verbatim from spec §8) declares the SET-REPLACE
 * contract AND the HARD-DELETE-on-diff-removal behaviour explicitly.
 * Variants do not have a `deletedAt`; the parent product's soft-delete
 * is the broader recovery net per prd §3.3.
 *
 * No `confirm: true` — non-destructive at the product-row level. The
 * tool description documents the variant-row hard-delete-on-omission
 * so the autonomous-agent contract is unambiguous.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  setProductVariants,
  SetProductVariantsInputSchema,
  SetProductVariantsResultSchema,
  type SetProductVariantsInput,
  type SetProductVariantsResult,
} from "@/server/services/variants/set-product-variants";
import { isWriteRole } from "@/server/tenant/context";

export const SetProductVariantsMcpInputSchema = SetProductVariantsInputSchema;
export type SetProductVariantsMcpInput = SetProductVariantsInput;

export const SetProductVariantsMcpOutputSchema =
  SetProductVariantsResultSchema;
export type SetProductVariantsMcpOutput = SetProductVariantsResult;

export const setProductVariantsTool: McpTool<
  SetProductVariantsMcpInput,
  SetProductVariantsMcpOutput
> = {
  name: "set_product_variants",
  description:
    "This tool replaces the entire set on the product. It is not a " +
    "patch. Read the rules below before calling. " +
    "Set the variants on a product (SET-REPLACE, NOT a patch; max 100). " +
    "The provided list REPLACES the existing variants for this product. " +
    "To preserve a variant across the call, include its existing id in " +
    "the input. To add a new variant, omit the id field. " +
    "HARD DELETE ON DIFF-REMOVAL: any variant currently on this product " +
    "whose id is NOT in the input array is HARD-DELETED. Variant rows " +
    "do not have a recovery window — to undelete a variant, re-submit " +
    "setProductVariants including its id with the same field values. " +
    "Each variant must reference exactly one value from each option type " +
    "defined on the product. SKUs must be unique within the tenant. " +
    "Owner or staff. Optimistic concurrency on the product's expectedUpdatedAt.",
  inputSchema:
    SetProductVariantsMcpInputSchema as unknown as z.ZodType<SetProductVariantsMcpInput>,
  outputSchema: SetProductVariantsMcpOutputSchema,
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
        "set_product_variants requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "set_product_variants dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await setProductVariants(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = result.after;
    return result;
  },
};
