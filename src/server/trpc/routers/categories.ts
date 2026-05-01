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
import { moveCategory } from "@/server/services/categories/move-category";
import {
  deleteCategory,
  DeleteCategoryInputSchema,
} from "@/server/services/categories/delete-category";
import {
  restoreCategory,
  RestoreCategoryInputSchema,
} from "@/server/services/categories/restore-category";
import {
  hardDeleteExpiredCategories,
  HardDeleteExpiredCategoriesInputSchema,
} from "@/server/services/categories/hard-delete-expired-categories";
import { z } from "zod";
import { appDb, withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import {
  RestoreWindowExpiredError,
  SlugTakenError,
  StaleWriteError,
} from "@/server/audit/error-codes";

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

  // 1a.4.2 follow-up — sibling-swap reorder. Replaces the operator-facing
  // "Position" field; the admin list page exposes up/down arrows, MCP
  // exposes `move_category_up` / `move_category_down`.
  moveUp: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      const result = await moveCategory(
        ctx.tx,
        { id: ctx.tenant.id },
        role,
        { id: input.id, direction: "up" },
      );
      ctx.auditPayloads.before = result.before;
      ctx.auditPayloads.after = result.after;
      return result;
    }),

  moveDown: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      const result = await moveCategory(
        ctx.tx,
        { id: ctx.tenant.id },
        role,
        { id: input.id, direction: "down" },
      );
      ctx.auditPayloads.before = result.before;
      ctx.auditPayloads.after = result.after;
      return result;
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

  // 1a.4.3 — soft-delete with cascade. Wire envelope is small; audit
  // payloads carry full Category snapshots so the append-only chain
  // records the post-delete state and the cascadedIds blast radius.
  delete: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(DeleteCategoryInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      try {
        const result = await deleteCategory(
          ctx.tx,
          { id: ctx.tenant.id },
          role,
          input,
        );
        ctx.auditPayloads.before = result.before;
        ctx.auditPayloads.after = {
          ...result.after,
          cascadedIds: result.cascadedIds,
        };
        return {
          id: result.after.id,
          deletedAt: result.after.deletedAt,
          cascadedIds: result.cascadedIds,
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

  // 1a.4.3 — single-row restore. RestoreWindowExpiredError →
  // BAD_REQUEST 'restore_expired' (precondition fail, not missing row).
  // Slug collision on restore → CONFLICT 'slug_taken'.
  // BAD_REQUEST 'parent_still_removed' flows through; the audit mapper
  // classifies it as 'validation_failed'.
  restore: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(RestoreCategoryInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      try {
        const result = await restoreCategory(
          ctx.tx,
          { id: ctx.tenant.id },
          role,
          input,
        );
        ctx.auditPayloads.before = result.before;
        ctx.auditPayloads.after = result.after;
        return {
          id: result.after.id,
          deletedAt: null as null,
          updatedAt: result.after.updatedAt,
        };
      } catch (err) {
        if (err instanceof RestoreWindowExpiredError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "restore_expired",
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

  // 1a.4.3 — recovery-window sweeper. Owner-only (NOT isWriteRole).
  // Audit `after` is bounded to {count, ids} — slugs/dryRun never cross
  // into the append-only chain (mirrors the products sweeper).
  hardDeleteExpired: mutationProcedure
    .use(requireRole({ roles: ["owner"] }))
    .input(HardDeleteExpiredCategoriesInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      const result = await hardDeleteExpiredCategories(
        ctx.tx,
        { id: ctx.tenant.id },
        role,
        input,
      );
      ctx.auditPayloads.after = { count: result.count, ids: result.ids };
      return result;
    }),
});
