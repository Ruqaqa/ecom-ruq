/**
 * `requireSession` — tRPC middleware that rejects anonymous callers with
 * UNAUTHORIZED and narrows `ctx.identity` to the session/bearer variant
 * for downstream consumers.
 *
 * This is the authentication gate. Per-role authorization (owner vs staff
 * vs customer) and the session-only identity constraint live in
 * `requireRole` (see ./require-role.ts).
 */
import { middleware, publicProcedure, TRPCError } from "../init";

export const requireSession = middleware(async ({ ctx, next }) => {
  if (ctx.identity.type === "anonymous") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "authentication required" });
  }
  return next({ ctx: { ...ctx, identity: ctx.identity } });
});

export const sessionProcedure = publicProcedure.use(requireSession);
