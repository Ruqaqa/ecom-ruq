/**
 * `set_product_options` — MCP mutation tool (chunk 1a.5.1).
 *
 * Mirrors the `set_product_categories` shape:
 *   - `auditMode:"mutation"` (registered in registry.ts) — runWithAudit
 *     opens withTenant + writes success / failure audit rows. Audit
 *     `before`/`after` are bounded snapshots (`{count, ids, hash}`-style)
 *     — spec §7.
 *   - `.strict()` at the MCP seam so adversarial extra keys reject.
 *   - bearer + isWriteRole gate; tools/list never advertises this tool
 *     to support / customer / anonymous identities.
 *
 * Tool description (verbatim from spec §8) explicitly declares the
 * SET-REPLACE contract and the 1a.5.1 transitional refusal of removal.
 *
 * No `confirm: true` — non-destructive set-replace at the product
 * level. Removal of a current option/value is REJECTED in 1a.5.1
 * (option_remove_not_supported_yet); the cascade flow lives in 1a.5.3.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  setProductOptions,
  SetProductOptionsInputSchema,
  SetProductOptionsResultSchema,
  type SetProductOptionsInput,
  type SetProductOptionsResult,
} from "@/server/services/variants/set-product-options";
import { isWriteRole } from "@/server/tenant/context";

export const SetProductOptionsMcpInputSchema = SetProductOptionsInputSchema;
export type SetProductOptionsMcpInput = SetProductOptionsInput;

export const SetProductOptionsMcpOutputSchema = SetProductOptionsResultSchema;
export type SetProductOptionsMcpOutput = SetProductOptionsResult;

export const setProductOptionsTool: McpTool<
  SetProductOptionsMcpInput,
  SetProductOptionsMcpOutput
> = {
  name: "set_product_options",
  description:
    "This tool replaces the entire set on the product. It is not a " +
    "patch. Read the rules below before calling. " +
    "Set the option types and their values on a product (SET-REPLACE, " +
    "NOT a patch). The provided list REPLACES the existing options/values " +
    "for this product. To rename or reorder an existing option type or " +
    "value without deleting it, include its existing id in the input with " +
    "the new fields. To add a new option type or value, omit the id field " +
    "— the server mints one. " +
    "An option or value present today but missing from the input is " +
    "REJECTED in this version (BAD_REQUEST option_remove_not_supported_yet); " +
    "use the future remove-option flow when it lands. " +
    "Caps: at most 3 option types per product, at most 100 values per " +
    "option. Owner or staff. Optimistic concurrency on the product's " +
    "expectedUpdatedAt.",
  inputSchema:
    SetProductOptionsMcpInputSchema as unknown as z.ZodType<SetProductOptionsMcpInput>,
  outputSchema: SetProductOptionsMcpOutputSchema,
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
        "set_product_options requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "set_product_options dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await setProductOptions(
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
