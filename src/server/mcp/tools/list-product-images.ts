/**
 * `list_product_images` — read tool, registered with `auditMode:"none"`.
 *
 * Bytes are NOT served by this tool — it returns metadata (storage
 * keys, derivative ledger, alt text). The actual image files are
 * served by the public CDN, not MCP.
 */
import { z } from "zod";
import type { McpTool } from "./registry";
import { McpError } from "../errors";
import { listProductImages } from "@/server/services/images/list-product-images";
import { appDb, withTenant } from "@/server/db";
import { buildAuthedTenantContext, isWriteRole } from "@/server/tenant/context";

export const ListProductImagesMcpInputSchema = z
  .object({
    productId: z.string().uuid(),
  })
  .strict();
export type ListProductImagesMcpInput = z.input<
  typeof ListProductImagesMcpInputSchema
>;

const ImageEntrySchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  fingerprintSha256: z.string(),
  storageKey: z.string(),
  originalFormat: z.string(),
  originalWidth: z.number().int().positive(),
  originalHeight: z.number().int().positive(),
  originalBytes: z.number().int().nonnegative(),
  derivatives: z.array(
    z.object({
      size: z.string(),
      format: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      storageKey: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  altText: z
    .object({ en: z.string().optional(), ar: z.string().optional() })
    .nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const ListProductImagesMcpOutputSchema = z.object({
  productId: z.string().uuid(),
  images: z.array(ImageEntrySchema),
});
export type ListProductImagesMcpOutput = z.infer<
  typeof ListProductImagesMcpOutputSchema
>;

export const listProductImagesTool: McpTool<
  ListProductImagesMcpInput,
  ListProductImagesMcpOutput
> = {
  name: "list_product_images",
  description:
    "Lists images on a product, sorted by position. Returns metadata " +
    "(storage keys, derivatives ledger, alt text). Image bytes themselves " +
    "are served by the public CDN, not this tool. Owner or staff.",
  inputSchema: ListProductImagesMcpInputSchema,
  outputSchema: ListProductImagesMcpOutputSchema,
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
        "list_product_images requires owner or staff role",
      );
    }
  },
  async handler(ctx, input, _tx) {
    if (ctx.identity.type !== "bearer") {
      throw new McpError("unauthorized", "bearer token required");
    }
    if (!appDb) {
      return { productId: input.productId, images: [] };
    }
    const { userId, tokenId, role } = ctx.identity;
    const tenantId = ctx.tenant.id;
    const authedCtx = buildAuthedTenantContext(
      { id: tenantId },
      { userId, actorType: "user", tokenId, role },
    );
    return withTenant(appDb, authedCtx, async (tx) => {
      const out = await listProductImages(tx, { id: tenantId }, role, input);
      return ListProductImagesMcpOutputSchema.parse(out);
    });
  },
};
