/**
 * `requireMembership(roles)` — composes `requireSession`, then asserts
 * the authenticated caller has a membership row for the resolved tenant
 * whose role is in `roles`. Rejects customers (session + null
 * membership) with FORBIDDEN — they're authenticated, they just don't
 * have admin privileges here.
 *
 * Narrows `ctx.membership` to non-null for downstream consumers.
 */
import { TRPCError } from "../init";
import { requireSession } from "./require-session";
import type { MembershipRole } from "@/server/auth/membership";

export function requireMembership(roles: readonly MembershipRole[]) {
  return requireSession.unstable_pipe(async ({ ctx, next }) => {
    const m = ctx.membership;
    if (!m || !roles.includes(m.role)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "insufficient role" });
    }
    return next({ ctx: { ...ctx, membership: m } });
  });
}
