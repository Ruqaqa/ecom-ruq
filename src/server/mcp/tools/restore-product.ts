/**
 * `restore_product` — MCP restore mutation tool.
 *
 * Mirror of delete_product. Window-expired errors surface via
 * `RestoreWindowExpiredError`; the dispatcher's mapErrorToAuditCode
 * recognizes the class and stamps audit row error
 * `{"code":"restore_expired"}`.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  restoreProduct,
  RestoreProductInputSchema,
  type RestoreProductInput,
} from "@/server/services/products/restore-product";
import { isWriteRole } from "@/server/tenant/context";

export const RestoreProductMcpInputSchema = RestoreProductInputSchema.strict();
export type RestoreProductMcpInput = RestoreProductInput;

export const RestoreProductMcpOutputSchema = z
  .object({
    id: z.string().uuid(),
    deletedAtIso: z.null(),
    updatedAtIso: z.string().datetime(),
  })
  .strict();
export type RestoreProductMcpOutput = z.infer<
  typeof RestoreProductMcpOutputSchema
>;

export const restoreProductTool: McpTool<
  RestoreProductMcpInput,
  RestoreProductMcpOutput
> = {
  name: "restore_product",
  description:
    "Restore a soft-deleted product (un-remove it). Only works within the 30-day recovery window after removal. Requires `confirm: true`. Requires owner or staff role.",
  inputSchema:
    RestoreProductMcpInputSchema as unknown as z.ZodType<RestoreProductMcpInput>,
  outputSchema: RestoreProductMcpOutputSchema,
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
        "restore_product requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "restore_product dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await restoreProduct(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = result.audit;
    return {
      id: result.audit.id,
      deletedAtIso: null,
      updatedAtIso: result.audit.updatedAt.toISOString(),
    };
  },
};
