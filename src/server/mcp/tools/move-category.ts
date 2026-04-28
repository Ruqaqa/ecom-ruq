/**
 * `move_category_up` / `move_category_down` — MCP mutation tools (1a.4.2 follow-up).
 *
 * Two thin wrappers around `moveCategory({ id, direction })`. Symmetric
 * pair so the wire surface mirrors the admin list page's up/down arrows
 * — operators driving via Claude Desktop / Claude Code see the exact
 * same affordance they see in the UI. Non-destructive (no `confirm`).
 *
 * Both tools register with `auditMode:"mutation"`; the shared adapter
 * opens the tenant-scoped tx, writes audit before/after, and routes
 * service-layer errors through `mapErrorToAuditCode`.
 */
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import { z } from "zod";
import {
  moveCategory,
  MoveCategoryResultSchema,
  type MoveCategoryDirection,
  type MoveCategoryResult,
} from "@/server/services/categories/move-category";
import { isWriteRole } from "@/server/tenant/context";

const MoveCategoryMcpInputSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();
type MoveCategoryMcpInput = z.input<typeof MoveCategoryMcpInputSchema>;

function buildMoveTool(
  direction: MoveCategoryDirection,
): McpTool<MoveCategoryMcpInput, MoveCategoryResult> {
  const name =
    direction === "up" ? "move_category_up" : "move_category_down";
  const description =
    direction === "up"
      ? "Move a category one slot earlier within its parent group. Idempotent at the top edge. Owner or staff."
      : "Move a category one slot later within its parent group. Idempotent at the bottom edge. Owner or staff.";

  return {
    name,
    description,
    inputSchema: MoveCategoryMcpInputSchema,
    outputSchema: MoveCategoryResultSchema,
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
          `${name} requires owner or staff role`,
        );
      }
    },
    async handler(ctx, input, tx) {
      if (tx === null) {
        throw new McpError(
          "internal_error",
          `${name} dispatcher contract: tx missing`,
        );
      }
      if (ctx.identity.type !== "bearer") {
        throw new McpError("unauthorized", "bearer token required");
      }
      const result = await moveCategory(
        tx,
        { id: ctx.tenant.id },
        ctx.identity.role,
        { id: input.id, direction },
      );
      ctx.auditOverride.before = result.before;
      ctx.auditOverride.after = result.after;
      return result;
    },
  };
}

export const moveCategoryUpTool = buildMoveTool("up");
export const moveCategoryDownTool = buildMoveTool("down");
