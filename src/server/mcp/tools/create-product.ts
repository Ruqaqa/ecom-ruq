/**
 * `create_product` — first real MCP mutation tool (sub-chunk 7.3).
 *
 * Registered with `auditMode:"mutation"` so `dispatchTool` routes it
 * through `runWithAudit`: the shared transport-neutral core opens
 * withTenant + writes a success audit row in-tx + writes a best-effort
 * failure audit row on throw, operation = `"mcp.create_product"`.
 * The tRPC equivalent writes operation = `"products.create"`. This
 * divergence is intentional — it lets audit-log consumers split
 * dashboards by transport in one grep.
 *
 * Role / visibility — Decision 2 (B) of the 7.3 plan:
 *   - `isVisibleFor(ctx)` returns false for non-bearer AND for bearer
 *     roles outside `['owner','staff']`. Support-role PATs and
 *     anonymous callers never see this tool in `tools/list`.
 *   - `authorize(ctx)` rejects the same set as defense-in-depth —
 *     both hooks must be in place (MCP clients can call tools without
 *     first listing them).
 *
 * Schema binding — `.strict()` at the MCP seam ONLY. The underlying
 * `CreateProductInputSchema` at the service layer is NOT mutated; the
 * tRPC admin-form path keeps its existing lenient behavior for
 * fields-not-yet-in-UI compatibility. At the MCP seam we want extra
 * keys to reject (adversarial inputs like `{ tenantId: "<other>" }`
 * must fail, NOT silently ignore).
 *
 * Output schema — union of `ProductOwnerSchema | ProductPublicSchema`
 * with owner FIRST: Zod unions pick the first matching member, and
 * `ProductOwnerSchema` is a superset of `ProductPublicSchema` (adds
 * `costPriceMinor`). If public came first, Zod would drop
 * `costPriceMinor` from owner responses on the wire. The service
 * already returns the role-gated shape — the union is the outer seam
 * lock so the dispatcher's `outputSchema.parse` doesn't reject either.
 *
 * Handler — thin: accepts `tx` from `runWithAudit` (the shared core
 * opens the tenant-scoped tx exactly once) and delegates to the
 * existing service function. No re-implementation, no second tx
 * opening (which would violate `withTenant`'s flat-only invariant).
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import {
  createProduct,
  CreateProductInputSchema,
  ProductOwnerSchema,
  ProductPublicSchema,
  type CreateProductInput,
  type ProductOwner,
  type ProductPublic,
} from "@/server/services/products/create-product";

// `.strict()` at the MCP seam only — see module docstring.
export const CreateProductMcpInputSchema = CreateProductInputSchema.strict();
export type CreateProductMcpInput = CreateProductInput;

// Owner FIRST — see module docstring. ProductOwnerSchema is a superset.
export const CreateProductMcpOutputSchema = z.union([
  ProductOwnerSchema,
  ProductPublicSchema,
]);
export type CreateProductMcpOutput = ProductOwner | ProductPublic;

function isWriteRole(role: string): boolean {
  return role === "owner" || role === "staff";
}

export const createProductTool: McpTool<
  CreateProductMcpInput,
  CreateProductMcpOutput
> = {
  name: "create_product",
  description:
    "Create a product under the caller's tenant. Returns the role-gated product shape (owner/staff get costPriceMinor; support/customer see the public shape). Requires owner or staff role.",
  inputSchema: CreateProductMcpInputSchema,
  outputSchema: CreateProductMcpOutputSchema,
  isVisibleFor(ctx) {
    // Decision 2 (B) — hide from tools/list for non-owner/non-staff.
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
        "create_product requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, tx) {
    if (tx === null) {
      // Tripwire: mutation tools MUST receive a tx from runWithAudit.
      // Parallel to tRPC's `narrowMutationContext` shape — a broken
      // dispatcher contract shouldn't hand us null and silently fall
      // through to a service call with no tenant-scoped tx.
      throw new McpError(
        "internal_error",
        "create_product dispatcher contract: tx missing",
      );
    }
    if (ctx.identity.type !== "bearer") {
      // Unreachable when invoked through dispatchTool (authorize already
      // threw). Kept for the same defense-in-depth reason as ping.
      throw new McpError("unauthorized", "bearer token required");
    }
    return createProduct(
      tx,
      { id: ctx.tenant.id, defaultLocale: ctx.tenant.defaultLocale },
      ctx.identity.role,
      input,
    );
  },
};
