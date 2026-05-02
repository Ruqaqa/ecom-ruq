/**
 * Images tRPC router — chunk 1a.7.1 Block 5a (metadata-only).
 *
 * Five endpoints:
 *   - images.list (query)            — admin-only (owner+staff)
 *   - images.delete (mutation)       — confirm:true; cascade-shifts positions
 *   - images.setProductCover (mutation)
 *   - images.setVariantCover (mutation)
 *   - images.setAltText (mutation)
 *
 * Bytes do NOT flow through tRPC (security C-1: tRPC body cap is the
 * MCP-style 64KB; uploads carry up to 15MB so they go through the
 * Block 5b /api/admin/images/{upload,replace} route handlers).
 *
 * Error translation: closed-set wire messages stay as TRPCError
 * `message` strings. Audit classification flows through the existing
 * `mapErrorToAuditCode` via TRPCError code (BAD_REQUEST →
 * validation_failed, NOT_FOUND → not_found, CONFLICT → conflict,
 * INTERNAL_SERVER_ERROR → internal_error). StaleWriteError → audit
 * code `stale_write` via the .cause peel.
 */
import { router, publicProcedure, TRPCError } from "../init";
import { mutationProcedure } from "../middleware/audit-wrap";
import { requireRole } from "../middleware/require-role";
import { deriveRole } from "../ctx-role";
import { appDb, withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { StaleWriteError } from "@/server/audit/error-codes";
import {
  listProductImages,
  ListProductImagesInputSchema,
} from "@/server/services/images/list-product-images";
import {
  deleteProductImage,
  DeleteProductImageInputSchema,
} from "@/server/services/images/delete-product-image";
import {
  setProductCoverImage,
  SetProductCoverImageInputSchema,
} from "@/server/services/images/set-product-cover-image";
import {
  setVariantCoverImage,
  SetVariantCoverImageInputSchema,
} from "@/server/services/images/set-variant-cover-image";
import {
  setProductImageAltText,
  SetProductImageAltTextInputSchema,
} from "@/server/services/images/set-product-image-alt-text";

export const imagesRouter = router({
  list: publicProcedure
    .use(requireRole({ roles: ["owner", "staff"], identity: "any" }))
    .input(ListProductImagesInputSchema)
    .query(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      if (!appDb) {
        return { productId: input.productId, images: [] };
      }
      const { userId } = ctx.identity;
      const tokenId =
        ctx.identity.type === "bearer" ? ctx.identity.tokenId : null;
      const authedCtx = buildAuthedTenantContext(
        { id: ctx.tenant.id },
        { userId, actorType: "user", tokenId, role },
      );
      return withTenant(appDb, authedCtx, (tx) =>
        listProductImages(tx, { id: ctx.tenant.id }, role, input),
      );
    }),

  delete: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(DeleteProductImageInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      try {
        const result = await deleteProductImage(
          ctx.tx,
          { id: ctx.tenant.id },
          role,
          input,
        );
        ctx.auditPayloads.before = result.before;
        ctx.auditPayloads.after = result.after;
        return {
          deletedImageId: result.deletedImageId,
          productId: result.productId,
        };
      } catch (err) {
        if (err instanceof StaleWriteError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "stale_write",
            cause: err,
          });
        }
        throw err;
      }
    }),

  setProductCover: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(SetProductCoverImageInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      try {
        const result = await setProductCoverImage(
          ctx.tx,
          { id: ctx.tenant.id },
          role,
          input,
        );
        ctx.auditPayloads.before = result.before;
        ctx.auditPayloads.after = result.after;
        return {
          productId: result.productId,
          oldCoverImageId: result.oldCoverImageId,
          newCoverImageId: result.newCoverImageId,
        };
      } catch (err) {
        if (err instanceof StaleWriteError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "stale_write",
            cause: err,
          });
        }
        throw err;
      }
    }),

  setVariantCover: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(SetVariantCoverImageInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      try {
        const result = await setVariantCoverImage(
          ctx.tx,
          { id: ctx.tenant.id },
          role,
          input,
        );
        ctx.auditPayloads.before = result.before;
        ctx.auditPayloads.after = result.after;
        return {
          variantId: result.variantId,
          oldCoverImageId: result.oldCoverImageId,
          newCoverImageId: result.newCoverImageId,
        };
      } catch (err) {
        if (err instanceof StaleWriteError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "stale_write",
            cause: err,
          });
        }
        throw err;
      }
    }),

  setAltText: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(SetProductImageAltTextInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      try {
        const result = await setProductImageAltText(
          ctx.tx,
          { id: ctx.tenant.id },
          role,
          input,
        );
        ctx.auditPayloads.before = result.before;
        ctx.auditPayloads.after = result.after;
        return {
          imageId: result.imageId,
          altText: result.altText,
        };
      } catch (err) {
        if (err instanceof StaleWriteError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "stale_write",
            cause: err,
          });
        }
        throw err;
      }
    }),
});
