/**
 * `update_product` — MCP mutation tool (chunk 1a.2).
 *
 * MCP boundary speaks in SAR (riyals) — the AI surface should never
 * see "halalas" or "minor units." This tool's input shape uses
 * `costPriceSar` (decimal riyals); the handler converts to halalas
 * before calling the service. Output also rewrites cost back to SAR.
 * The service layer keeps storing halalas (exact integer math).
 *
 * Mirrors `create_product`'s shape:
 *   - auditMode:"mutation" — runWithAudit opens withTenant + writes
 *     success row in-tx; failures land via writeAuditInOwnTx.
 *   - .strict() at the MCP seam so adversarial extra keys (`tenantId`,
 *     `role`, `costPriceMinor`, etc) reject — failedPaths captures
 *     the offending key.
 *   - Owner-first union output so Zod picks the Tier-B-superset shape
 *     before falling back to ProductPublic.
 *   - isVisibleFor + authorize gate to bearer + write role; tools/list
 *     never advertises this tool to support/customer.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import { localizedTextPartial } from "@/lib/i18n/localized";
import { slugSchema } from "@/lib/product-slug";
import {
  updateProduct,
  type UpdateProductInput,
} from "@/server/services/products/update-product";
import { isWriteRole } from "@/server/tenant/context";
import {
  ProductOwnerMcpSchema,
  ProductPublicMcpSchema,
  productToMcpShape,
  sarToHalalas,
  type ProductOwnerMcp,
  type ProductPublicMcp,
} from "./_product-shapes";

const MCP_EDITABLE_KEYS = [
  "slug",
  "name",
  "description",
  "status",
  "categoryId",
  "costPriceSar",
] as const;

export const UpdateProductMcpInputSchema = z
  .object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    slug: slugSchema.optional(),
    name: localizedTextPartial({ max: 256 }).optional(),
    description: localizedTextPartial({ max: 4096 }).optional(),
    status: z.enum(["draft", "active"]).optional(),
    categoryId: z.string().uuid().nullable().optional(),
    // Decimal riyals. `.nullable().optional()` keeps the
    // "leave alone" / "clear" / "set" tri-state. Owner-only — the
    // service rejects non-owner callers that include this key.
    costPriceSar: z.number().nonnegative().nullable().optional(),
  })
  .strict()
  .refine(
    (input) => MCP_EDITABLE_KEYS.some((k) => k in input),
    { message: "at least one editable field required" },
  );
export type UpdateProductMcpInput = z.input<typeof UpdateProductMcpInputSchema>;

// Owner FIRST — ProductOwnerMcpSchema is the superset (carries
// costPriceSar). Public is the fallback for non-owner roles, which
// drop the field entirely.
export const UpdateProductMcpOutputSchema = z.union([
  ProductOwnerMcpSchema,
  ProductPublicMcpSchema,
]);
export type UpdateProductMcpOutput = ProductOwnerMcp | ProductPublicMcp;

export const updateProductTool: McpTool<
  UpdateProductMcpInput,
  UpdateProductMcpOutput
> = {
  name: "update_product",
  description:
    "Update an existing product under the caller's tenant. Cost prices are in SAR (riyals) — for example 850.50 means 850 riyals 50 halalas. Use list_products to find the product's id first. Requires owner or staff role.",
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
    // Convert SAR → halalas at the boundary. `key in input` semantics
    // preserved across the conversion: absent costPriceSar → absent
    // costPriceMinor (leave alone); null → null (clear); number → halalas.
    const serviceInput: UpdateProductInput = {
      id: input.id,
      expectedUpdatedAt: input.expectedUpdatedAt,
    };
    if ("slug" in input) serviceInput.slug = input.slug;
    if ("name" in input) serviceInput.name = input.name;
    if ("description" in input) serviceInput.description = input.description;
    if ("status" in input) serviceInput.status = input.status;
    if ("categoryId" in input) serviceInput.categoryId = input.categoryId;
    if ("costPriceSar" in input) {
      serviceInput.costPriceMinor =
        input.costPriceSar === null || input.costPriceSar === undefined
          ? input.costPriceSar
          : sarToHalalas(input.costPriceSar);
    }
    // Domain errors (SlugTakenError, StaleWriteError) bubble bare —
    // dispatchTool's toMcpError + mapErrorToAuditCode classify them.
    const result = await updateProduct(
      tx,
      { id: ctx.tenant.id },
      ctx.identity.role,
      serviceInput,
    );
    ctx.auditOverride.before = result.before;
    ctx.auditOverride.after = result.audit;
    return productToMcpShape(result.public);
  },
};
