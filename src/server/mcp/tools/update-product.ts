/**
 * `update_product` — MCP mutation tool (chunk 1a.2).
 *
 * Mirrors `create_product`'s shape:
 *   - auditMode:"mutation" — runWithAudit opens withTenant + writes
 *     success row in-tx; failures land via writeAuditInOwnTx.
 *   - .strict() at the MCP seam so adversarial extra keys (`tenantId`,
 *     `role`, etc) reject — failedPaths captures the offending key.
 *   - Owner-first union output so Zod picks the Tier-B-superset shape
 *     before falling back to ProductPublic; the service already
 *     returns the role-gated wire shape.
 *   - isVisibleFor + authorize gate to bearer + write role; tools/list
 *     never advertises this tool to support/customer.
 *
 * Tool description deliberately does NOT mention `slug`, `tenantId`,
 * or `role` — the schema is the source of truth, and operator-facing
 * descriptions stay free of internals an attacker could lean on.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  ProductOwnerSchema,
  ProductPublicSchema,
  type ProductOwner,
  type ProductPublic,
} from "@/server/services/products/create-product";
import {
  updateProduct,
  UpdateProductInputSchema,
  type UpdateProductInput,
} from "@/server/services/products/update-product";
import { isWriteRole } from "@/server/tenant/context";
import { StaleWriteError } from "@/server/audit/error-codes";

export const UpdateProductMcpInputSchema = (
  UpdateProductInputSchema as unknown as z.ZodObject<z.ZodRawShape>
).strict();
// `UpdateProductInputSchema` is `z.object(...).refine(...)`; tightening to
// strict requires reaching through the refine wrapper. The refined shape
// (the editable-fields-required check) still applies because Zod evaluates
// `.strict()` as a child operation on the underlying object.
export type UpdateProductMcpInput = UpdateProductInput;

// Owner FIRST — ProductOwner is a superset, so a union with public first
// would drop costPriceMinor from owner responses on the wire.
export const UpdateProductMcpOutputSchema = z.union([
  ProductOwnerSchema,
  ProductPublicSchema,
]);
export type UpdateProductMcpOutput = ProductOwner | ProductPublic;

export const updateProductTool: McpTool<
  UpdateProductMcpInput,
  UpdateProductMcpOutput
> = {
  name: "update_product",
  description:
    "Update an existing product under the caller's tenant. Returns the role-gated product shape. Use list_products to find the product's id first. Requires owner or staff role.",
  inputSchema: UpdateProductMcpInputSchema as unknown as z.ZodType<UpdateProductMcpInput>,
  outputSchema: UpdateProductMcpOutputSchema,
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
        "update_product requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      throw new McpError(
        "internal_error",
        "update_product dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    try {
      const result = await updateProduct(
        tx,
        { id: ctx.tenant.id },
        ctx.identity.role,
        input,
      );
      // Record the full Tier-B before/after even when the wire return
      // is the role-gated subset — see McpAuditOverride.
      ctx.auditOverride.before = result.before;
      ctx.auditOverride.after = result.audit;
      return result.public;
    } catch (err) {
      if (err instanceof StaleWriteError) {
        // dispatchTool's toMcpError() runs mapErrorToAuditCode (which
        // recognizes StaleWriteError directly) → kind 'stale_write' →
        // JSON-RPC -32009. Re-throw bare; the dispatcher classifies.
        throw err;
      }
      throw err;
    }
  },
};
