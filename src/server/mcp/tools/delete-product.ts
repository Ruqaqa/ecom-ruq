/**
 * `delete_product` — MCP soft-delete mutation tool.
 *
 * Mirrors the shape of `update_product`:
 *   - auditMode:"mutation" — `runWithAudit` opens withTenant + writes
 *     success row in-tx; failures audit via writeAuditInOwnTx.
 *   - `.strict()` so adversarial extra keys reject (failedPaths captures
 *     the offending key).
 *   - bearer + isWriteRole gate; tools/list never advertises this tool
 *     to support/customer.
 *
 * `confirm: z.literal(true)` flows through the JSON Schema as `const:
 * true` so MCP clients see the requirement at introspection time.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  deleteProduct,
  DeleteProductInputSchema,
  type DeleteProductInput,
} from "@/server/services/products/delete-product";
import { isWriteRole } from "@/server/tenant/context";

export const DeleteProductMcpInputSchema = DeleteProductInputSchema.strict();
export type DeleteProductMcpInput = DeleteProductInput;

export const DeleteProductMcpOutputSchema = z
  .object({
    id: z.string().uuid(),
    deletedAtIso: z.string().datetime(),
  })
  .strict();
export type DeleteProductMcpOutput = z.infer<
  typeof DeleteProductMcpOutputSchema
>;

export const deleteProductTool: McpTool<
  DeleteProductMcpInput,
  DeleteProductMcpOutput
> = {
  name: "delete_product",
  description:
    "Soft-delete a product under the caller's tenant. The row is hidden from the storefront and the default product list. There is a 30-day window to restore it; after that it is permanently purged. Requires `confirm: true`. Requires owner or staff role.",
  inputSchema: DeleteProductMcpInputSchema as unknown as z.ZodType<DeleteProductMcpInput>,
  outputSchema: DeleteProductMcpOutputSchema,
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
        "delete_product requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "delete_product dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    const result = await deleteProduct(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      input,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = result.audit;
    return {
      id: result.audit.id,
      deletedAtIso: result.audit.deletedAt!.toISOString(),
    };
  },
};
