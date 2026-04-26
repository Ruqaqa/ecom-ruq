/**
 * `create_category` — MCP mutation tool (chunk 1a.4.1).
 *
 * Mirrors `create_product` shape:
 *   - auditMode:"mutation" — runWithAudit opens withTenant + writes
 *     success / failure audit rows.
 *   - `.strict()` at the MCP seam so adversarial extra keys reject.
 *   - bearer + isWriteRole gate; tools/list never advertises this tool
 *     to support/customer.
 *
 * Service-layer slug-collision and parent-not-found errors bubble bare —
 * `dispatchTool`'s `toMcpError` + `mapErrorToAuditCode` classify them
 * (SlugTakenError → 'conflict'; TRPCError BAD_REQUEST → 'validation_failed').
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  createCategory,
  CreateCategoryInputSchema,
  CategorySchema,
  type CreateCategoryInput,
} from "@/server/services/categories/create-category";
import { isWriteRole } from "@/server/tenant/context";

export const CreateCategoryMcpInputSchema = CreateCategoryInputSchema.strict();
export type CreateCategoryMcpInput = CreateCategoryInput;

export const CreateCategoryMcpOutputSchema = CategorySchema;
export type CreateCategoryMcpOutput = z.infer<
  typeof CreateCategoryMcpOutputSchema
>;

export const createCategoryTool: McpTool<
  CreateCategoryMcpInput,
  CreateCategoryMcpOutput
> = {
  name: "create_category",
  description:
    "Create a category under the caller's tenant. Latin slug, bilingual name, optional parent (depth ≤ 3). Owner or staff.",
  inputSchema: CreateCategoryMcpInputSchema,
  outputSchema: CreateCategoryMcpOutputSchema,
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
        "create_category requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "create_category dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    return createCategory(tx, { id: ctx.tenant.id }, ctx.identity.role, input);
  },
};
