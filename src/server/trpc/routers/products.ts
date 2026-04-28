/**
 * Products tRPC router.
 *
 * `products.create` is the first real mutation in the codebase and the
 * first composition of the full middleware stack under mutationProcedure:
 *
 *   mutationProcedure                                  (audit-wrap + tx via withTenant)
 *     .use(requireRole({ roles:['owner','staff'] }))   (authn + role gate, any identity)
 *     .input(CreateProductInputSchema)                 (Zod input validation)
 *     .mutation((opts) => createProduct(...))          (delegate to service)
 *
 * The middleware composition order is load-bearing:
 *   - audit-wrap runs FIRST so a failure audit row captures requireRole's
 *     FORBIDDEN decision, not just service errors.
 *   - requireRole runs AFTER audit-wrap, so the authz decision + its
 *     failure code ('forbidden') flow through mapErrorToAuditCode.
 *   - .input() runs before the .mutation() body, so invalid inputs short-
 *     circuit with a Zod BAD_REQUEST that audit-wrap maps to 'validation_failed'.
 *
 * Service call shape (architect Low-02): NOT the full `ctx.tenant` — just the
 * narrowed projection the service signature declares. role comes from
 * `deriveRole(ctx)` (see ../ctx-role.ts), NEVER from input (there is no
 * role field on CreateProductInputSchema).
 *
 * Role channel invariant (sub-chunk 7.2 + 7.6.2): bearer callers carry
 * `effectiveRole` on `ctx.identity`; session callers read
 * `membership.role`. `deriveRole` is the ONLY reader — we do NOT inline
 * `ctx.membership?.role` here or anywhere else under routers/. The
 * `requireRole` middleware also goes through `deriveRole` (closing the
 * S-5 blind spot `requireMembership` left open). The
 * `scripts/check-role-invariants.ts` grep-lint enforces both rules in CI.
 *
 * Identity constraint: `products.create` intentionally accepts bearer
 * callers (`identity: 'any'` — the default) because mobile/MCP clients
 * need to create products. `tokens.*` is the opposite: session-only.
 */
import { router, publicProcedure, TRPCError } from "../init";
import { mutationProcedure } from "../middleware/audit-wrap";
import { requireRole } from "../middleware/require-role";
import { deriveRole } from "../ctx-role";
import {
  createProduct,
  CreateProductInputSchema,
} from "@/server/services/products/create-product";
import {
  listProducts,
  ListProductsInputSchema,
} from "@/server/services/products/list-products";
import {
  updateProduct,
  UpdateProductInputSchema,
} from "@/server/services/products/update-product";
import {
  getProduct,
  GetProductInputSchema,
} from "@/server/services/products/get-product";
import {
  deleteProduct,
  DeleteProductInputSchema,
} from "@/server/services/products/delete-product";
import {
  restoreProduct,
  RestoreProductInputSchema,
} from "@/server/services/products/restore-product";
import {
  hardDeleteExpiredProducts,
  HardDeleteExpiredProductsInputSchema,
} from "@/server/services/products/hard-delete-expired-products";
import {
  setProductCategories,
  SetProductCategoriesInputSchema,
} from "@/server/services/products/set-product-categories";
import { appDb, withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import {
  RestoreWindowExpiredError,
  SlugTakenError,
  StaleWriteError,
} from "@/server/audit/error-codes";

export const productsRouter = router({
  // Read path — no audit wrap (reads bypass audit per prd §3.7). Role
  // comes from `deriveRole(ctx)`; `scripts/check-role-invariants.ts`
  // enforces every router reads role exclusively through it.
  list: publicProcedure
    .use(requireRole({ roles: ["owner", "staff"], identity: "any" }))
    .input(ListProductsInputSchema)
    .query(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      if (!appDb) {
        return { items: [], nextCursor: null, hasMore: false };
      }
      // requireRole narrows ctx.identity away from anonymous.
      const { userId } = ctx.identity;
      const tokenId =
        ctx.identity.type === "bearer" ? ctx.identity.tokenId : null;
      const authedCtx = buildAuthedTenantContext(
        { id: ctx.tenant.id },
        { userId, actorType: "user", tokenId, role },
      );
      return withTenant(appDb, authedCtx, (tx) =>
        listProducts(tx, { id: ctx.tenant.id }, role, input),
      );
    }),

  // Read-by-id used by the RSC edit page to pre-fill the form. Owner/
  // staff only — same identity:'any' rule as `list` so MCP/PAT callers
  // can read for tooling but customers/anonymous can't probe ids.
  get: publicProcedure
    .use(requireRole({ roles: ["owner", "staff"], identity: "any" }))
    .input(GetProductInputSchema)
    .query(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      if (!appDb) return null;
      const { userId } = ctx.identity;
      const tokenId =
        ctx.identity.type === "bearer" ? ctx.identity.tokenId : null;
      const authedCtx = buildAuthedTenantContext(
        { id: ctx.tenant.id },
        { userId, actorType: "user", tokenId, role },
      );
      return withTenant(appDb, authedCtx, (tx) =>
        getProduct(tx, { id: ctx.tenant.id }, role, input),
      );
    }),

  update: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(UpdateProductInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed — Tier-B gate integrity violated",
        });
      }
      try {
        const result = await updateProduct(
          ctx.tx,
          { id: ctx.tenant.id },
          role,
          input,
        );
        // Override the audit shape: the wire return is the role-gated
        // subset, but the audit chain records the full Tier-B before/
        // after row regardless of caller role. See AuditWrapAuditPayloads.
        ctx.auditPayloads.before = result.before;
        ctx.auditPayloads.after = result.audit;
        return result.public;
      } catch (err) {
        // Translate domain errors to wire-shaped CONFLICTs; the audit
        // mapper recognizes both via TRPCError `.cause` so the closed-
        // set audit code stays accurate ('stale_write' vs 'conflict').
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

  // Soft-delete. Returns a small wire envelope; audit payloads carry
  // full ProductOwner shapes — required for the append-only chain to
  // record post-delete state.
  delete: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(DeleteProductInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      try {
        const result = await deleteProduct(
          ctx.tx,
          { id: ctx.tenant.id },
          role,
          input,
        );
        ctx.auditPayloads.before = result.before;
        ctx.auditPayloads.after = result.audit;
        return { id: result.audit.id, deletedAt: result.audit.deletedAt };
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

  // Restore. RestoreWindowExpiredError → BAD_REQUEST `restore_expired`
  // (precondition fail, not missing row).
  restore: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(RestoreProductInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      try {
        const result = await restoreProduct(
          ctx.tx,
          { id: ctx.tenant.id },
          role,
          input,
        );
        ctx.auditPayloads.before = result.before;
        ctx.auditPayloads.after = result.audit;
        return {
          id: result.audit.id,
          deletedAt: null as null,
          updatedAt: result.audit.updatedAt,
        };
      } catch (err) {
        if (err instanceof RestoreWindowExpiredError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "restore_expired",
            cause: err,
          });
        }
        throw err;
      }
    }),

  // Recovery-window sweeper. Owner-only (NOT isWriteRole). Audit
  // `after` is bounded to {count, ids} — slugs/dryRun never cross into
  // the append-only chain.
  hardDeleteExpired: mutationProcedure
    .use(requireRole({ roles: ["owner"] }))
    .input(HardDeleteExpiredProductsInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      const result = await hardDeleteExpiredProducts(
        ctx.tx,
        { id: ctx.tenant.id },
        role,
        input,
      );
      ctx.auditPayloads.after = { count: result.count, ids: result.ids };
      return result;
    }),

  // 1a.4.2 — set the categories on a product (set-replace semantics).
  // OCC anchored on the product row; setting the link set bumps
  // `products.updated_at` because category linkage is part of the
  // product's observable state. Audit `before`/`after` carry id+slug
  // refs (security sign-off shape).
  setCategories: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(SetProductCategoriesInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      try {
        const result = await setProductCategories(
          ctx.tx,
          { id: ctx.tenant.id },
          role,
          input,
        );
        ctx.auditPayloads.before = result.before;
        ctx.auditPayloads.after = result.after;
        return result;
      } catch (err) {
        if (err instanceof StaleWriteError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "stale_write",
            cause: err,
          });
        }
        // BAD_REQUEST `category_not_found` and NOT_FOUND
        // `product_not_found` flow through; mapErrorToAuditCode classifies
        // them as `validation_failed` and `not_found` respectively.
        throw err;
      }
    }),

  create: mutationProcedure
    .use(requireRole({ roles: ["owner", "staff"] }))
    .input(CreateProductInputSchema)
    .mutation(async ({ ctx, input }) => {
      // `role` MUST come from `deriveRole(ctx)`. NEVER from `input`, NEVER
      // from a literal, NEVER from `ctx.membership?.role` inlined. See
      // ../ctx-role.ts for the Tier-B-collapse reasoning. This wire-site
      // pattern is the template for block 5 and every future admin
      // mutation — copy-paste armor.
      const role = deriveRole(ctx);
      if (!role) {
        // Unreachable today — `deriveRole` always returns a value from the
        // `Role` union. Tripwire for a future refactor that makes the
        // return type nullable: we want a loud INTERNAL_SERVER_ERROR
        // (audit-logged as `{"code":"internal_error"}`) rather than a
        // silent Tier-B gate collapse back to customer-shape for an owner
        // caller.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed — Tier-B gate integrity violated",
        });
      }
      try {
        return await createProduct(
          ctx.tx,
          { id: ctx.tenant.id, defaultLocale: ctx.tenant.defaultLocale },
          role,
          input,
        );
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
});
