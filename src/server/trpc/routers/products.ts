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
import { z } from "zod";
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
import { getProduct } from "@/server/services/products/get-product";
import { appDb, withTenant } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";
import { StaleWriteError } from "@/server/audit/error-codes";

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
    .input(z.object({ id: z.string().uuid() }))
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
        if (err instanceof StaleWriteError) {
          // Translate to CONFLICT for the wire (clients can recognize
          // a usable status code); cause preserved so audit-wrap's
          // mapErrorToAuditCode classifies as 'stale_write' rather
          // than the generic 'internal_error' / 'conflict' branches.
          throw new TRPCError({
            code: "CONFLICT",
            message: "stale_write",
            cause: err,
          });
        }
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
      return createProduct(
        ctx.tx,
        { id: ctx.tenant.id, defaultLocale: ctx.tenant.defaultLocale },
        role,
        input,
      );
    }),
});
