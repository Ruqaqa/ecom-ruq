/**
 * Tokens tRPC router — sub-chunk 7.1, tightened in 7.6.2.
 *
 * Three procedures. All three are SESSION-ONLY and OWNER-ONLY in Phase 0:
 * bearer tokens must not self-administer other bearer tokens (locked user
 * decision, 2026-04-23). The Phase 7 RBAC permission builder adds
 * `tokens.manage` as the escape hatch when fine-grained permissions land.
 *
 *   - `create`  = mutationProcedure
 *                   .use(requireRole({ roles:['owner'], identity:'session' }))
 *                   .input(...).mutation(...)
 *     Audit auto-wraps. Returns plaintext ONCE.
 *   - `revoke`  = mutationProcedure
 *                   .use(requireRole({ roles:['owner'], identity:'session' }))
 *                   .input(...).mutation(...)
 *     Audit auto-wraps. Soft-revoke. `confirm: true` required.
 *   - `list`    = publicProcedure
 *                   .use(requireRole({ roles:['owner'], identity:'session' }))
 *                   .query(...)
 *     NOT audited (queries never are, per prd.md §3.7). Double-tightened
 *     in 7.6.2: staff no longer has an operational need, and the PAT
 *     inventory is reconnaissance surface. The service-layer gate at
 *     `listAccessTokens` still admits owner+staff as defense-in-depth
 *     for non-tRPC callers; the router simply refuses everyone else.
 *
 * Wire-site pattern (copied from `products.ts`): role derives from
 * `deriveRole(ctx)`, NEVER from input. `requireRole` also reads through
 * `deriveRole` (not `ctx.membership.role`), closing the S-5 blind spot
 * `requireMembership` left open. The tripwire throws INTERNAL_SERVER_ERROR
 * if role derivation ever returns falsy (future refactor canary). Service
 * is passed the narrow `{ id: ctx.tenant.id }` projection + the caller
 * user id.
 */
import { router, publicProcedure, TRPCError } from "../init";
import { mutationProcedure } from "../middleware/audit-wrap";
import { requireRole } from "../middleware/require-role";
import { deriveRole } from "../ctx-role";
import {
  createAccessToken,
  CreateAccessTokenInputSchema,
} from "@/server/services/tokens/create-access-token";
import {
  revokeAccessToken,
  RevokeAccessTokenInputSchema,
} from "@/server/services/tokens/revoke-access-token";
import { listAccessTokens } from "@/server/services/tokens/list-access-tokens";
import { withTenant, appDb } from "@/server/db";
import { buildAuthedTenantContext } from "@/server/tenant/context";

export const tokensRouter = router({
  create: mutationProcedure
    .use(requireRole({ roles: ["owner"], identity: "session" }))
    .input(CreateAccessTokenInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      // The authedCtx carries the caller's userId — that's the user the
      // token is MINTED FOR. Input never supplies userId.
      const callerUserId = ctx.authedCtx.userId;
      if (!callerUserId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "authedCtx.userId missing for tokens.create",
        });
      }
      return createAccessToken(
        ctx.tx,
        { id: ctx.tenant.id },
        callerUserId,
        role,
        input,
      );
    }),

  revoke: mutationProcedure
    .use(requireRole({ roles: ["owner"], identity: "session" }))
    .input(RevokeAccessTokenInputSchema)
    .mutation(async ({ ctx, input }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      const callerUserId = ctx.authedCtx.userId;
      if (!callerUserId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "authedCtx.userId missing for tokens.revoke",
        });
      }
      return revokeAccessToken(
        ctx.tx,
        { id: ctx.tenant.id },
        callerUserId,
        role,
        input,
      );
    }),

  // Queries are NOT audited per prd.md §3.7. `list` uses publicProcedure
  // (no audit-wrap) then double-tightens via requireRole: session-only
  // AND owner-only. Staff no longer has an operational need for the PAT
  // inventory (locked 7.6.2 decision); the service-layer gate inside
  // `listAccessTokens` still admits owner+staff as defense-in-depth for
  // non-tRPC callers.
  list: publicProcedure
    .use(requireRole({ roles: ["owner"], identity: "session" }))
    .query(async ({ ctx }) => {
      const role = deriveRole(ctx);
      if (!role) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "role derivation failed",
        });
      }
      if (!appDb) {
        // No DB configured — empty list is the least-surprising answer.
        return [];
      }
      // `requireRole({ identity:'session' })` rejects bearer at the
      // middleware — by the time we get here ctx.identity.type is
      // 'session' (not anonymous, not bearer). We keep the bearer
      // branch below for structural completeness only; it is
      // unreachable on the tokens.list path.
      const identity = ctx.identity;
      const authedCtx = buildAuthedTenantContext(
        { id: ctx.tenant.id },
        {
          userId: identity.userId,
          actorType: "user",
          tokenId: identity.type === "bearer" ? identity.tokenId : null,
          role,
        },
      );
      return withTenant(appDb, authedCtx, async (tx) =>
        listAccessTokens(tx, { id: ctx.tenant.id }, role),
      );
    }),
});
