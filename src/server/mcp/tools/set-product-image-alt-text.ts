/**
 * `set_product_image_alt_text` — bilingual partial-merge alt text.
 * Pass `altText: null` to clear entirely; a partial pair preserves
 * the unspecified side.
 *
 * Not destructive — does NOT require `confirm:true`.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  setProductImageAltText,
  SetProductImageAltTextInputSchema,
  type SetProductImageAltTextInput,
} from "@/server/services/images/set-product-image-alt-text";
import { isWriteRole } from "@/server/tenant/context";

export const SetProductImageAltTextMcpInputSchema =
  SetProductImageAltTextInputSchema;
export type SetProductImageAltTextMcpInput = SetProductImageAltTextInput;

export const SetProductImageAltTextMcpOutputSchema = z.object({
  imageId: z.string().uuid(),
  altText: z
    .object({ en: z.string().optional(), ar: z.string().optional() })
    .nullable(),
});
export type SetProductImageAltTextMcpOutput = z.infer<
  typeof SetProductImageAltTextMcpOutputSchema
>;

export const setProductImageAltTextTool: McpTool<
  SetProductImageAltTextMcpInput,
  SetProductImageAltTextMcpOutput
> = {
  name: "set_product_image_alt_text",
  description:
    "Sets bilingual alt text on an image. Partial-merge: providing only " +
    "`en` preserves an existing `ar` and vice versa. Pass null to clear " +
    "entirely. Owner or staff.",
  inputSchema: SetProductImageAltTextMcpInputSchema as unknown as z.ZodType<
    SetProductImageAltTextMcpInput
  >,
  outputSchema: SetProductImageAltTextMcpOutputSchema,
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
        "set_product_image_alt_text requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "set_product_image_alt_text dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await setProductImageAltText(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = result.after;
    return {
      imageId: result.imageId,
      altText: result.altText,
    };
  },
};
