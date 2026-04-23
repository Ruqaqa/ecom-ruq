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
import { router, TRPCError } from "../init";
import { mutationProcedure } from "../middleware/audit-wrap";
import { requireRole } from "../middleware/require-role";
import { deriveRole } from "../ctx-role";
import {
  createProduct,
  CreateProductInputSchema,
} from "@/server/services/products/create-product";

export const productsRouter = router({
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
