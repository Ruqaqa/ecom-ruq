/**
 * Categories tRPC router (chunk 1a.4.1).
 *
 * Mirrors `productsRouter`:
 *   - read paths via `publicProcedure` + `requireRole({ identity:'any' })`,
 *     so MCP/PAT callers can use them as well as session callers.
 *   - mutations via `mutationProcedure` + `requireRole`. SlugTakenError
 *     → CONFLICT 'slug_taken'; StaleWriteError → CONFLICT 'stale_write';
 *     domain BAD_REQUESTs (category_cycle / category_depth_exceeded /
 *     parent_not_found) flow through unchanged — `mapErrorToAuditCode`
 *     stamps them as `validation_failed`.
 *
 * Role channel: `deriveRole(ctx)`. The role-invariants lint forbids
 * inlining `ctx.membership?.role`.
 */
import { router, publicProcedure, TRPCError } from "../init";
import { mutationProcedure } from "../middleware/audit-wrap";
import { requireRole } from "../middleware/require-role";
import { deriveRole } from "../ctx-role";
import {
  createCategory,
  CreateCategoryInputSchema,
} from "@/server/services/categories/create-category";
import {
  listCategories,
  ListCategoriesInputSchema,
} from "@/server/services/categories/list-categories";
import {
  updateCategory,
  UpdateCategoryInputSchema,
} from "@/server/services/categories/update-category";
import {
  listCategoriesForProduct,
  ListForProductInputSchema,
} from "@/server/services/categories/list-for-product";
import { appDb, withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { SlugTakenError, StaleWriteError } from "@/server/audit/error-codes";

export const categoriesRouter = router({
  list: publicProcedure
    .use(requireRole({ roles: ["owner", "staff"], identity: "any" }))
    .input(ListCategoriesInputSchema)
    .query(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      if (!appDb) return { items: [] };
      const { userId } = ctx.identity;
      const tokenId =
        ctx.identity.type === "bearer" ? ctx.identity.tokenId : null;
      const authedCtx = buildAuthedTenantContext(
        { id: ctx.tenant.id },
        { userId, actorType: "user", tokenId, role },
      );
      return withTenant(appDb, authedCtx, (tx) =>
        listCategories(
          tx,
          { id: ctx.tenant.id, defaultLocale: ctx.tenant.defaultLocale },
          role,
          input,
        ),
      );
    }),

  // 1a.4.2 — read the categories currently linked to a product. Used by
  // the admin product-edit RSC to prefill chips. Cross-tenant probes,
  // phantom productIds, and soft-deleted products all return `{ items: [] }`
  // — opaque, no existence-leak.
  listForProduct: publicProcedure
    .use(requireRole({ roles: ["owner", "staff"], identity: "any" }))
    .input(ListForProductInputSchema)
    .query(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      if (!appDb) return { items: [] };
      const { userId } = ctx.identity;
      const tokenId =
        ctx.identity.type === "bearer" ? ctx.identity.tokenId : null;
      const authedCtx = buildAuthedTenantContext(
        { id: ctx.tenant.id },
        { userId, actorType: "user", tokenId, role },
      );
      return withTenant(appDb, authedCtx, (tx) =>
        listCategoriesForProduct(tx, { id: ctx.tenant.id }, role, input),
      );
    }),

  create: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(CreateCategoryInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      try {
        return await createCategory(ctx.tx, { id: ctx.tenant.id }, role, input);
      } catch (err) {
        if (err instanceof SlugTakenError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "slug_taken",
            cause: err,
          });
        }
        throw err;
      }
    }),

  update: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(UpdateCategoryInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      try {
        const result = await updateCategory(
          ctx.tx,
          { id: ctx.tenant.id },
          role,
          input,
        );
        ctx.auditPayloads.before = result.before;
        ctx.auditPayloads.after = result.after;
        return result.after;
      } catch (err) {
        if (err instanceof StaleWriteError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "stale_write",
            cause: err,
          });
        }
        if (err instanceof SlugTakenError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "slug_taken",
            cause: err,
          });
        }
        throw err;
      }
    }),
});
