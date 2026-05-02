/**
 * `set_product_options` — MCP mutation tool (chunk 1a.5.1, amended 1a.5.3).
 *
 * Mirrors the `set_product_categories` shape:
 *   - `auditMode:"mutation"` (registered in registry.ts) — runWithAudit
 *     opens withTenant + writes success / failure audit rows. Audit
 *     `before`/`after` are bounded snapshots (`{count, ids, hash}`-style)
 *     — spec §7. `after` carries `cascadedVariantIds` per 1a.5.3 spec §1.
 *   - `.strict()` at the MCP seam so adversarial extra keys reject.
 *   - bearer + isWriteRole gate; tools/list never advertises this tool
 *     to support / customer / anonymous identities.
 *
 * Tool description (verbatim from 1a.5.3 security spec §7) declares the
 * SET-REPLACE contract AND the cascade-on-omission contract for
 * autonomous agents — omitting an option type from input is a removal,
 * and every variant row referencing any of its values is hard-deleted
 * in the same call.
 *
 * No `confirm: true` — consistent with set_product_variants and
 * set_product_categories. The cascade contract is documented in the
 * tool description (carried in tools/list payloads to autonomous agents).
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
    "An option type present today but missing from the input is REMOVED " +
    "from the product; ALL VARIANT ROWS that reference any value of that " +
    "option type are HARD-DELETED in the same call. Variant rows do not " +
    "have a recovery window — the parent product's soft-delete is the " +
    "broader recovery net. Removing an option value (keeping the option " +
    "type) is similarly a removal: every variant referencing that value " +
    "is hard-deleted. There is no preview; if you are unsure, list the " +
    "product's current variants first via getProductWithVariants. " +
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
