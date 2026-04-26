/**
 * `hard_delete_expired_products` — MCP recovery-window sweeper.
 *
 * Owner-only — tighter than other write tools (bulk + irreversible).
 * `dryRun: true` previews the purge; `dryRun: false` performs it.
 *
 * Audit-shape invariant: the wire return is full {count, ids, slugs?,
 * dryRun}, but `ctx.auditOverride.after` is bounded to {count, ids}.
 * slugs (in dryRun) and dryRun itself NEVER cross into audit_log.
 * Bilingual name fields could carry future buyer PII; audit_log is
 * append-only and PDPL-undeletable.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  hardDeleteExpiredProducts,
  HardDeleteExpiredProductsInputSchema,
  type HardDeleteExpiredProductsInput,
} from "@/server/services/products/hard-delete-expired-products";

export const HardDeleteExpiredProductsMcpInputSchema =
  HardDeleteExpiredProductsInputSchema.strict();
export type HardDeleteExpiredProductsMcpInput = HardDeleteExpiredProductsInput;

export const HardDeleteExpiredProductsMcpOutputSchema = z
  .object({
    count: z.number().int().nonnegative(),
    ids: z.array(z.string().uuid()),
    slugs: z.array(z.string()).optional(),
    dryRun: z.boolean(),
  })
  .strict();
export type HardDeleteExpiredProductsMcpOutput = z.infer<
  typeof HardDeleteExpiredProductsMcpOutputSchema
>;

export const hardDeleteExpiredProductsTool: McpTool<
  HardDeleteExpiredProductsMcpInput,
  HardDeleteExpiredProductsMcpOutput
> = {
  name: "hard_delete_expired_products",
  description:
    "Permanently purge soft-deleted products whose 30-day recovery window has passed. Use `dryRun: true` first to preview which rows will be removed. Owner-only — bulk and irreversible. Requires `confirm: true` even with `dryRun: true`.",
  inputSchema:
    HardDeleteExpiredProductsMcpInputSchema as unknown as z.ZodType<HardDeleteExpiredProductsMcpInput>,
  outputSchema: HardDeleteExpiredProductsMcpOutputSchema,
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
        "hard_delete_expired_products is owner-only",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "hard_delete_expired_products dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await hardDeleteExpiredProducts(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    // Audit `after` is bounded to {count, ids} — slugs/dryRun never
    // cross into the append-only chain.
    ctx.auditOverride.after = { count: result.count, ids: result.ids };
    return result;
  },
};
