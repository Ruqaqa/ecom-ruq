/**
 * `delete_product_image` — destructive MCP tool, requires `confirm:true`.
 * `auditMode:"mutation"` so dispatchTool wraps it in `runWithAudit`.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  deleteProductImage,
  DeleteProductImageInputSchema,
  type DeleteProductImageInput,
} from "@/server/services/images/delete-product-image";
import { isWriteRole } from "@/server/tenant/context";

export const DeleteProductImageMcpInputSchema = DeleteProductImageInputSchema;
export type DeleteProductImageMcpInput = DeleteProductImageInput;

export const DeleteProductImageMcpOutputSchema = z.object({
  deletedImageId: z.string().uuid(),
  productId: z.string().uuid(),
});
export type DeleteProductImageMcpOutput = z.infer<
  typeof DeleteProductImageMcpOutputSchema
>;

export const deleteProductImageTool: McpTool<
  DeleteProductImageMcpInput,
  DeleteProductImageMcpOutput
> = {
  name: "delete_product_image",
  description:
    "Hard-deletes an image from a product. Cascade-shifts remaining " +
    "image positions (image at position N deleted → positions > N shift " +
    "down by 1). Storage files are removed best-effort. Variant covers " +
    "pointing at this image are automatically cleared (FK ON DELETE SET " +
    "NULL). Owner or staff. Requires confirm:true.",
  inputSchema: DeleteProductImageMcpInputSchema as unknown as z.ZodType<
    DeleteProductImageMcpInput
  >,
  outputSchema: DeleteProductImageMcpOutputSchema,
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
        "delete_product_image requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "delete_product_image dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await deleteProductImage(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = result.after;
    return {
      deletedImageId: result.deletedImageId,
      productId: result.productId,
    };
  },
};
