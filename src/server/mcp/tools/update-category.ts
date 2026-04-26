/**
 * `update_category` — MCP mutation tool (chunk 1a.4.1).
 *
 * Mirrors `update_product` shape. The handler sets
 * `ctx.auditOverride.before` / `.after` so the audit chain captures the
 * full Category snapshot regardless of the wire return.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import { localizedTextPartial } from "@/lib/i18n/localized";
import { slugSchema } from "@/lib/product-slug";
import {
  updateCategory,
  type UpdateCategoryInput,
} from "@/server/services/categories/update-category";
import {
  CategorySchema,
  type Category,
} from "@/server/services/categories/create-category";
import { isWriteRole } from "@/server/tenant/context";

const MCP_EDITABLE_KEYS = [
  "slug",
  "name",
  "description",
  "parentId",
  "position",
] as const;

export const UpdateCategoryMcpInputSchema = z
  .object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    slug: slugSchema.optional(),
    name: localizedTextPartial({ max: 256 }).optional(),
    description: localizedTextPartial({ max: 4096 }).optional(),
    parentId: z.string().uuid().nullable().optional(),
    position: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (input) => MCP_EDITABLE_KEYS.some((k) => k in input),
    { message: "at least one editable field required" },
  );
export type UpdateCategoryMcpInput = z.input<
  typeof UpdateCategoryMcpInputSchema
>;

export const UpdateCategoryMcpOutputSchema = CategorySchema;
export type UpdateCategoryMcpOutput = Category;

export const updateCategoryTool: McpTool<
  UpdateCategoryMcpInput,
  UpdateCategoryMcpOutput
> = {
  name: "update_category",
  description:
    "Update a category — slug, bilingual name/description, parent, or position. Optimistic concurrency via expectedUpdatedAt. Owner or staff.",
  inputSchema:
    UpdateCategoryMcpInputSchema as unknown as z.ZodType<UpdateCategoryMcpInput>,
  outputSchema: UpdateCategoryMcpOutputSchema,
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
        "update_category requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "update_category dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const serviceInput: UpdateCategoryInput = {
      id: input.id,
      expectedUpdatedAt: input.expectedUpdatedAt,
    };
    if ("slug" in input) serviceInput.slug = input.slug;
    if ("name" in input) serviceInput.name = input.name;
    if ("description" in input) serviceInput.description = input.description;
    if ("parentId" in input) serviceInput.parentId = input.parentId;
    if ("position" in input) serviceInput.position = input.position;

    const result = await updateCategory(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      serviceInput,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = result.after;
    return result.after;
  },
};
