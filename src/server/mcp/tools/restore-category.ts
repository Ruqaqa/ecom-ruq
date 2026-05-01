/**
 * `restore_category` — MCP restore mutation tool (chunk 1a.4.3).
 *
 * Single-row restore — cascade-restore is NOT supported. The description
 * is part of the contract: an autonomous agent must not assume that
 * restoring a parent brings its sub-categories back.
 *
 * Window-expired errors surface via `RestoreWindowExpiredError`; the
 * dispatcher's mapErrorToAuditCode recognizes the class and stamps audit
 * row error `{"code":"restore_expired"}`. Slug-collision-on-restore →
 * `SlugTakenError` (PDPL-safe class) → audit code 'conflict'.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  restoreCategory,
  RestoreCategoryInputSchema,
  type RestoreCategoryInput,
} from "@/server/services/categories/restore-category";
import { isWriteRole } from "@/server/tenant/context";

export const RestoreCategoryMcpInputSchema =
  RestoreCategoryInputSchema.strict();
export type RestoreCategoryMcpInput = RestoreCategoryInput;

export const RestoreCategoryMcpOutputSchema = z
  .object({
    id: z.string().uuid(),
    deletedAtIso: z.null(),
    updatedAtIso: z.string().datetime(),
  })
  .strict();
export type RestoreCategoryMcpOutput = z.infer<
  typeof RestoreCategoryMcpOutputSchema
>;

export const restoreCategoryTool: McpTool<
  RestoreCategoryMcpInput,
  RestoreCategoryMcpOutput
> = {
  name: "restore_category",
  description:
    "Restore a soft-deleted category (un-remove it). Single-row only — sub-categories must be restored individually. If the parent is still removed, restore the parent first. Only works within the 30-day recovery window after removal. Requires `confirm: true`. Requires owner or staff role.",
  inputSchema:
    RestoreCategoryMcpInputSchema as unknown as z.ZodType<RestoreCategoryMcpInput>,
  outputSchema: RestoreCategoryMcpOutputSchema,
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
        "restore_category requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "restore_category dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await restoreCategory(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = result.after;
    return {
      id: result.after.id,
      deletedAtIso: null,
      updatedAtIso: result.after.updatedAt.toISOString(),
    };
  },
};
