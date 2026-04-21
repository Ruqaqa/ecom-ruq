/**
 * Tokens tRPC router — sub-chunk 7.1.
 *
 * Three procedures, mirroring the products router conventions:
 *   - `create`  = mutationProcedure . use(requireMembership(['owner'])) . input(...) . mutation(...)
 *     Audit auto-wraps. Returns plaintext ONCE. Owner-only mint.
 *   - `revoke`  = mutationProcedure . use(requireMembership(['owner'])) . input(...) . mutation(...)
 *     Audit auto-wraps. Soft-revoke. Owner-only. `confirm: true` required.
 *   - `list`    = publicProcedure   . use(requireMembership(['owner','staff'])) . query(...)
 *     NOT audited (queries never are, per prd.md §3.7). Owner + staff
 *     allowed; support falls through to FORBIDDEN via requireMembership.
 *
 * Wire-site pattern (copied from `products.ts`): role derives from
 * `deriveRole(ctx)`, NEVER from input. The tripwire throws
 * INTERNAL_SERVER_ERROR if role derivation ever returns falsy (future
 * refactor canary). Service is passed the narrow `{ id: ctx.tenant.id }`
 * projection + `ctx.authedCtx.userId` for the caller user id.
 */
import { router, publicProcedure, TRPCError } from "../init";
import { mutationProcedure } from "../middleware/audit-wrap";
import { requireMembership } from "../middleware/require-membership";
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
    .use(requireMembership(["owner"]))
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
    .use(requireMembership(["owner"]))
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
  // (no audit-wrap) then gates via requireMembership(['owner','staff']).
  list: publicProcedure
    .use(requireMembership(["owner", "staff"]))
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
      // `requireMembership` composes `requireSession`, so ctx.identity is
      // narrowed to session | bearer here — never anonymous. We branch on
      // bearer only because it's the one path that carries a tokenId.
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
