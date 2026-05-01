/**
 * `hard_delete_expired_categories` — MCP recovery-window sweeper
 * (chunk 1a.4.3).
 *
 * Owner-only — bulk + irreversible (FK cascade purges descendants and
 * `product_categories` join rows). Tighter than other write tools.
 *
 * Cascade-safety is enforced inside the service: a parent whose subtree
 * still contains a young (<30d) soft descendant is excluded from the
 * purge set so the descendant's recovery window cannot be silently
 * ended by FK cascade.
 *
 * Audit-shape invariant: the wire return is full {count, ids, slugs?,
 * dryRun}, but `ctx.auditOverride.after` is bounded to {count, ids}.
 * slugs (in dryRun) and dryRun itself NEVER cross into audit_log
 * (PDPL-undeletable, bilingual name fields could carry future buyer PII).
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  hardDeleteExpiredCategories,
  HardDeleteExpiredCategoriesInputSchema,
  type HardDeleteExpiredCategoriesInput,
} from "@/server/services/categories/hard-delete-expired-categories";

export const HardDeleteExpiredCategoriesMcpInputSchema =
  HardDeleteExpiredCategoriesInputSchema.strict();
export type HardDeleteExpiredCategoriesMcpInput =
  HardDeleteExpiredCategoriesInput;

export const HardDeleteExpiredCategoriesMcpOutputSchema = z
  .object({
    count: z.number().int().nonnegative(),
    ids: z.array(z.string().uuid()),
    slugs: z.array(z.string()).optional(),
    dryRun: z.boolean(),
  })
  .strict();
export type HardDeleteExpiredCategoriesMcpOutput = z.infer<
  typeof HardDeleteExpiredCategoriesMcpOutputSchema
>;

export const hardDeleteExpiredCategoriesTool: McpTool<
  HardDeleteExpiredCategoriesMcpInput,
  HardDeleteExpiredCategoriesMcpOutput
> = {
  name: "hard_delete_expired_categories",
  description:
    "Permanently purge soft-deleted categories whose 30-day recovery window has passed. Use `dryRun: true` first to preview which rows will be removed. A parent whose subtree still contains a recently-removed sub-category is held back until the sub-category's own window expires. Owner-only — bulk and irreversible. Requires `confirm: true` even with `dryRun: true`.",
  inputSchema:
    HardDeleteExpiredCategoriesMcpInputSchema as unknown as z.ZodType<HardDeleteExpiredCategoriesMcpInput>,
  outputSchema: HardDeleteExpiredCategoriesMcpOutputSchema,
  isVisibleFor(ctx) {
    if (ctx.identity.type !== "bearer") return false;
    // Owner-only — not isWriteRole.
    return ctx.identity.role === "owner";
  },
  authorize(ctx) {
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    if (ctx.identity.role !== "owner") {
      throw new McpError(
        "forbidden",
        "hard_delete_expired_categories is owner-only",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "hard_delete_expired_categories dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await hardDeleteExpiredCategories(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    ctx.auditOverride.after = { count: result.count, ids: result.ids };
    return result;
  },
};
