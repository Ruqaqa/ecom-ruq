/**
 * `list_categories` — MCP read tool (chunk 1a.4.1).
 *
 * Mirrors `list_products`: registered with `auditMode:"none"` (reads
 * don't audit per prd §3.7); the dispatcher hands tx=null and we open
 * our own non-audit tx via withTenant.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  listCategories,
  ListCategoriesInputSchema,
} from "@/server/services/categories/list-categories";
import { CategorySchema } from "@/server/services/categories/create-category";
import { appDb, withTenant } from "@/server/db";
import { buildAuthedTenantContext, isWriteRole } from "@/server/tenant/context";

export const ListCategoriesMcpInputSchema = ListCategoriesInputSchema.strict();
export type ListCategoriesMcpInput = z.input<
  typeof ListCategoriesMcpInputSchema
>;

// Output shape mirrors the service: same Category schema (depth + parentId
// already on it), wrapped in `{ items }`.
export const ListCategoriesMcpOutputSchema = z.object({
  items: z.array(CategorySchema),
});
export type ListCategoriesMcpOutput = z.infer<
  typeof ListCategoriesMcpOutputSchema
>;

export const listCategoriesTool: McpTool<
  ListCategoriesMcpInput,
  ListCategoriesMcpOutput
> = {
  name: "list_categories",
  description:
    "List categories under the caller's tenant, flat with parentId + depth. Owner or staff.",
  inputSchema: ListCategoriesMcpInputSchema,
  outputSchema: ListCategoriesMcpOutputSchema,
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
        "list_categories requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, _tx) {
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    if (!appDb) {
      return { items: [] };
    }
    const { userId, tokenId, role } = ctx.identity;
    const tenantId = ctx.tenant.id;
    const authedCtx = buildAuthedTenantContext(
      { id: tenantId },
      { userId, actorType: "user", tokenId, role },
    );
    return withTenant(appDb, authedCtx, async (tx) => {
      const out = await listCategories(
        tx,
        { id: tenantId, defaultLocale: ctx.tenant.defaultLocale },
        role,
        input,
      );
      return ListCategoriesMcpOutputSchema.parse(out);
    });
  },
};
