/**
 * `delete_category` — MCP soft-delete mutation tool (chunk 1a.4.3).
 *
 * Mirrors `delete_product` plus the cascade-aware output: the wire
 * `cascadedIds` carries the target id plus every live descendant the
 * service flipped on this call, so an autonomous agent can read the
 * blast radius of its own action.
 *
 * Description is part of the contract: it explicitly states the
 * cascade behavior so an agent does not need to guess.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  deleteCategory,
  DeleteCategoryInputSchema,
  type DeleteCategoryInput,
} from "@/server/services/categories/delete-category";
import { isWriteRole } from "@/server/tenant/context";

export const DeleteCategoryMcpInputSchema = DeleteCategoryInputSchema.strict();
export type DeleteCategoryMcpInput = DeleteCategoryInput;

export const DeleteCategoryMcpOutputSchema = z
  .object({
    id: z.string().uuid(),
    deletedAtIso: z.string().datetime(),
    cascadedIds: z.array(z.string().uuid()),
  })
  .strict();
export type DeleteCategoryMcpOutput = z.infer<
  typeof DeleteCategoryMcpOutputSchema
>;

export const deleteCategoryTool: McpTool<
  DeleteCategoryMcpInput,
  DeleteCategoryMcpOutput
> = {
  name: "delete_category",
  description:
    "Soft-delete a category under the caller's tenant. Removes the category AND every category beneath it in the same step. Removed categories are hidden from the storefront and from category pickers, but products linked to them keep the link so a restore is reversible. There is a 30-day window to restore a removed category; after that it is permanently purged. Requires `confirm: true`. Requires owner or staff role.",
  inputSchema:
    DeleteCategoryMcpInputSchema as unknown as z.ZodType<DeleteCategoryMcpInput>,
  outputSchema: DeleteCategoryMcpOutputSchema,
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
        "delete_category requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "delete_category dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await deleteCategory(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = {
      ...result.after,
      cascadedIds: result.cascadedIds,
    };
    return {
      id: result.after.id,
      deletedAtIso: result.after.deletedAt!.toISOString(),
      cascadedIds: result.cascadedIds,
    };
  },
};
