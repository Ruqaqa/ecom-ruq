/**
 * `set_product_cover_image` — promote an image to position 0 (cover).
 * Atomic position swap with the existing cover.
 *
 * Not destructive — does NOT require `confirm:true`.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  setProductCoverImage,
  SetProductCoverImageInputSchema,
  type SetProductCoverImageInput,
} from "@/server/services/images/set-product-cover-image";
import { isWriteRole } from "@/server/tenant/context";

export const SetProductCoverImageMcpInputSchema =
  SetProductCoverImageInputSchema;
export type SetProductCoverImageMcpInput = SetProductCoverImageInput;

export const SetProductCoverImageMcpOutputSchema = z.object({
  productId: z.string().uuid(),
  oldCoverImageId: z.string().uuid(),
  newCoverImageId: z.string().uuid(),
});
export type SetProductCoverImageMcpOutput = z.infer<
  typeof SetProductCoverImageMcpOutputSchema
>;

export const setProductCoverImageTool: McpTool<
  SetProductCoverImageMcpInput,
  SetProductCoverImageMcpOutput
> = {
  name: "set_product_cover_image",
  description:
    "Promotes an image to position 0 (cover). Atomic two-step swap " +
    "with the current cover; the previous cover takes the target's " +
    "old position. No-op when the target is already cover. Owner or staff.",
  inputSchema: SetProductCoverImageMcpInputSchema as unknown as z.ZodType<
    SetProductCoverImageMcpInput
  >,
  outputSchema: SetProductCoverImageMcpOutputSchema,
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
        "set_product_cover_image requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "set_product_cover_image dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await setProductCoverImage(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = result.after;
    return {
      productId: result.productId,
      oldCoverImageId: result.oldCoverImageId,
      newCoverImageId: result.newCoverImageId,
    };
  },
};
