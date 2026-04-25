/**
 * `list_products` — registered with `auditMode:"none"` (reads don't
 * audit per prd §3.7). Decision-1 widening at `audit-adapter.ts` still
 * writes a `forbidden` failure-audit row when `authorize` refuses. The
 * MCP `limit` default (10) is intentionally lower than the tRPC default
 * (20) — AI callers tend to over-paginate and smaller pages keep
 * context budgets tight. `auditMode:"none"` means the dispatcher hands
 * us `tx = null`, so this handler opens its own non-audit tx.
 *
 * MCP boundary speaks in SAR (riyals) — owner callers see items with
 * `costPriceSar`, never `costPriceMinor`. Non-owner roles (staff today)
 * still get the public shape (no cost field at all). Service stays in
 * halalas; conversion happens here per item.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import { listProducts } from "@/server/services/products/list-products";
import { appDb, withTenant } from "@/server/db";
import { buildAuthedTenantContext, isWriteRole } from "@/server/tenant/context";
import {
  ProductOwnerMcpSchema,
  ProductPublicMcpSchema,
  productToMcpShape,
  type ProductOwnerMcp,
  type ProductPublicMcp,
} from "./_product-shapes";

export const ListProductsMcpInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(10),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type ListProductsMcpInput = z.input<typeof ListProductsMcpInputSchema>;

const ListProductsOutputOwnerMcpSchema = z.object({
  items: z.array(ProductOwnerMcpSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
const ListProductsOutputPublicMcpSchema = z.object({
  items: z.array(ProductPublicMcpSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

// Owner FIRST so Zod picks the cost-bearing shape over the bare public.
export const ListProductsMcpOutputSchema = z.union([
  ListProductsOutputOwnerMcpSchema,
  ListProductsOutputPublicMcpSchema,
]);
export type ListProductsMcpOutput =
  | { items: ProductOwnerMcp[]; nextCursor: string | null; hasMore: boolean }
  | { items: ProductPublicMcp[]; nextCursor: string | null; hasMore: boolean };

export const listProductsTool: McpTool<
  ListProductsMcpInput,
  ListProductsMcpOutput
> = {
  name: "list_products",
  description:
    "List products in the current tenant, newest-updated first. Returns one page of results with an optional cursor for the next page. Cost prices in the response are in SAR (riyals). Requires owner or staff role.",
  inputSchema: ListProductsMcpInputSchema,
  outputSchema: ListProductsMcpOutputSchema,
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
        "list_products requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, _tx) {
    if (ctx.identity.type !== "bearer") {
      // Unreachable — authorize already threw. Defense-in-depth.
      throw new McpError("unauthorized", "bearer token required");
    }
    if (!appDb) {
      return { items: [], nextCursor: null, hasMore: false };
    }
    const { userId, tokenId, role } = ctx.identity;
    const tenantId = ctx.tenant.id;
    const authedCtx = buildAuthedTenantContext(
      { id: tenantId },
      { userId, actorType: "user", tokenId, role },
    );
    return withTenant(appDb, authedCtx, async (tx) => {
      const out = await listProducts(tx, { id: tenantId }, role, input);
      const items = out.items.map((p) => productToMcpShape(p));
      return ListProductsMcpOutputSchema.parse({
        items,
        nextCursor: out.nextCursor,
        hasMore: out.hasMore,
      });
    });
  },
};
