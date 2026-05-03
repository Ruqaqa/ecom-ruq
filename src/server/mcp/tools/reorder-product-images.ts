/**
 * `reorder_product_images` — MCP mutation tool (chunk 1a.7.2 same-day
 * follow-up Block 2e).
 *
 * Mirrors `set_product_variants`:
 *   - `auditMode:"mutation"` — runWithAudit owns the transaction.
 *   - Audit `before`/`after` are bounded ReorderAuditSnapshot.
 *   - `.strict()` schema rejects adversarial extra keys.
 *
 * Tool description declares the SET-REPLACE contract explicitly so an
 * autonomous agent can't mistake this for a partial update.
 *
 * NOT destructive — does not require `confirm: true`.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  reorderProductImages,
  ReorderProductImagesInputSchema,
  type ReorderProductImagesInput,
} from "@/server/services/images/reorder-product-images";
import { isWriteRole } from "@/server/tenant/context";

export const ReorderProductImagesMcpInputSchema =
  ReorderProductImagesInputSchema;
export type ReorderProductImagesMcpInput = ReorderProductImagesInput;

export const ReorderProductImagesMcpOutputSchema = z.object({
  productId: z.string().uuid(),
  productUpdatedAt: z.string().datetime(),
});
export type ReorderProductImagesMcpOutput = z.infer<
  typeof ReorderProductImagesMcpOutputSchema
>;

export const reorderProductImagesTool: McpTool<
  ReorderProductImagesMcpInput,
  ReorderProductImagesMcpOutput
> = {
  name: "reorder_product_images",
  description:
    "Reorders the photos on a product. " +
    "SET-REPLACE CONTRACT: provide the FULL ordering of all images for " +
    "this product, not a partial update. The server validates set " +
    "equality — the input array must contain exactly the same image " +
    "ids that the product currently has, just in a different order. " +
    "Position 0 is the cover. Reads " +
    "`list_product_images` first to learn the current set; sends back " +
    "every id in the desired order. Mismatches (duplicate id, foreign " +
    "id, missing id) are rejected with `image_set_mismatch`. Owner or " +
    "staff. Optimistic concurrency on the product's expectedUpdatedAt.",
  inputSchema: ReorderProductImagesMcpInputSchema as unknown as z.ZodType<
    ReorderProductImagesMcpInput
  >,
  outputSchema: ReorderProductImagesMcpOutputSchema,
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
        "reorder_product_images requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "reorder_product_images dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await reorderProductImages(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = result.after;
    return {
      productId: result.productId,
      productUpdatedAt: result.productUpdatedAt,
    };
  },
};
