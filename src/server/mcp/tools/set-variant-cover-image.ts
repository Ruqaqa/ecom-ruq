/**
 * `set_variant_cover_image` — set or clear a variant's cover image.
 * Image must belong to the same product as the variant. Pass null to
 * clear (variant falls back to product cover).
 *
 * Not destructive — does NOT require `confirm:true`.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  setVariantCoverImage,
  SetVariantCoverImageInputSchema,
  type SetVariantCoverImageInput,
} from "@/server/services/images/set-variant-cover-image";
import { isWriteRole } from "@/server/tenant/context";

export const SetVariantCoverImageMcpInputSchema =
  SetVariantCoverImageInputSchema;
export type SetVariantCoverImageMcpInput = SetVariantCoverImageInput;

export const SetVariantCoverImageMcpOutputSchema = z.object({
  variantId: z.string().uuid(),
  oldCoverImageId: z.string().uuid().nullable(),
  newCoverImageId: z.string().uuid().nullable(),
});
export type SetVariantCoverImageMcpOutput = z.infer<
  typeof SetVariantCoverImageMcpOutputSchema
>;

export const setVariantCoverImageTool: McpTool<
  SetVariantCoverImageMcpInput,
  SetVariantCoverImageMcpOutput
> = {
  name: "set_variant_cover_image",
  description:
    "Sets or clears a variant's cover image. The image must belong to " +
    "the same product as the variant. Pass null to clear — the variant " +
    "then falls back to the product cover. Owner or staff.",
  inputSchema: SetVariantCoverImageMcpInputSchema as unknown as z.ZodType<
    SetVariantCoverImageMcpInput
  >,
  outputSchema: SetVariantCoverImageMcpOutputSchema,
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
        "set_variant_cover_image requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "set_variant_cover_image dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await setVariantCoverImage(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = result.after;
    return {
      variantId: result.variantId,
      oldCoverImageId: result.oldCoverImageId,
      newCoverImageId: result.newCoverImageId,
    };
  },
};
