/**
 * `set_product_categories` — MCP mutation tool (chunk 1a.4.2).
 *
 * Mirrors `update_category` shape:
 *   - `auditMode:"mutation"` (registered in registry.ts) — runWithAudit
 *     opens withTenant + writes success / failure audit rows. Audit
 *     `before`/`after` payloads are the id+slug refs the service
 *     returns (ids alone would be opaque; slugs make the audit row
 *     human-meaningful without leaking other category fields).
 *   - `.strict()` at the MCP seam so adversarial extra keys reject.
 *   - bearer + isWriteRole gate; tools/list never advertises this tool
 *     to support / customer / anonymous identities.
 *
 * Decision lock from security: SET-REPLACE only. No paired
 * attach/detach surface — would split the audit story and double the
 * surface area without operational benefit.
 *
 * Service-layer errors bubble bare. `dispatchTool`'s `toMcpError` +
 * `mapErrorToAuditCode` classify them: TRPCError NOT_FOUND
 * `product_not_found` → 'not_found'; TRPCError BAD_REQUEST
 * `category_not_found` → 'validation_failed'; StaleWriteError →
 * 'stale_write'.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  setProductCategories,
  SetProductCategoriesInputSchema,
  SetProductCategoriesResultSchema,
  type SetProductCategoriesInput,
  type SetProductCategoriesResult,
} from "@/server/services/products/set-product-categories";
import { isWriteRole } from "@/server/tenant/context";

export const SetProductCategoriesMcpInputSchema =
  SetProductCategoriesInputSchema;
export type SetProductCategoriesMcpInput = SetProductCategoriesInput;

export const SetProductCategoriesMcpOutputSchema =
  SetProductCategoriesResultSchema;
export type SetProductCategoriesMcpOutput = SetProductCategoriesResult;

export const setProductCategoriesTool: McpTool<
  SetProductCategoriesMcpInput,
  SetProductCategoriesMcpOutput
> = {
  name: "set_product_categories",
  description:
    "Set the categories on a product (set-replace, max 32). Empty array detaches all. Owner or staff. Optimistic concurrency on the product's expectedUpdatedAt.",
  inputSchema:
    SetProductCategoriesMcpInputSchema as unknown as z.ZodType<SetProductCategoriesMcpInput>,
  outputSchema: SetProductCategoriesMcpOutputSchema,
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
        "set_product_categories requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "set_product_categories dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await setProductCategories(
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
