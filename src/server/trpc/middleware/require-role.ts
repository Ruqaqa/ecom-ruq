/**
 * `requireRole(opts)` — tRPC middleware that closes two gaps the old
 * `requireMembership` left open:
 *
 *   1. Role-channel correctness. `requireMembership` read
 *      `ctx.membership?.role` directly; for bearer callers that is the
 *      PRE-demotion cached value (S-5). `requireRole` reads the role
 *      exclusively through `deriveRole(ctx)`, the single-source-of-truth
 *      helper that short-circuits to `identity.effectiveRole` on the
 *      bearer branch.
 *
 *   2. Identity-type constraint. `tokens.*` mutations are session-only in
 *      Phase 0: bearer tokens must not self-administer other bearer
 *      tokens. Pass `{ identity: 'session' }` to reject bearer callers
 *      with FORBIDDEN. Default is `'any'`.
 *
 * Runtime behavior:
 *   anonymous → UNAUTHORIZED "authentication required" (via requireSession).
 *   identity:'session' AND caller.identity.type==='bearer'
 *                    → FORBIDDEN "session required for this action".
 *   deriveRole(ctx) not in roles
 *                    → FORBIDDEN "insufficient role".
 *   otherwise        → pass-through; `ctx.membership` narrows non-null for
 *                      session callers that held a membership row.
 *
 * The two failure messages are LOAD-BEARING RAW STRING LITERALS at the
 * throw sites below. Do NOT extract to constants. Do NOT interpolate. Do
 * NOT translate. Forensic audit replay (and the B5/B6/B7 byte-exact
 * assertions) depend on exact matching.
 *
 * Role invariant R-2: this middleware lives outside `src/server/trpc/
 * routers/`, so its use of `.membership` in the runtime pipe is not
 * caught by R-2. R-3 is unaffected — role comes from `deriveRole(ctx)`,
 * never `ctx.identity.effectiveRole` directly.
 *
 * Phase 7 migration target: replace `requireRole({ roles })` with
 * `requirePermission({ permission })`. `identity:'session'` stays — it's
 * orthogonal to the role/permission axis.
 */
import { TRPCError } from "../init";
import { requireSession } from "./require-session";
import { deriveRole } from "../ctx-role";
import type { Role } from "@/server/tenant/context";

export interface RequireRoleOptions {
  roles: readonly Role[];
  /**
   * `'session'` rejects bearer callers with FORBIDDEN. `'any'` (default)
   * accepts both session and bearer.
   */
  identity?: "session" | "any";
}

export function requireRole(opts: RequireRoleOptions) {
  return requireSession.unstable_pipe(async ({ ctx, next }) => {
    if (opts.identity === "session" && ctx.identity.type === "bearer") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "session required for this action",
      });
    }
    const role = deriveRole(ctx);
    if (!opts.roles.includes(role)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "insufficient role",
      });
    }
    // Session callers with a role in the allowlist (owner/staff/support)
    // always have a membership row — customers fall through the role gate
    // above with `deriveRole` → 'customer'. Narrow the type here so
    // downstream procedures access `ctx.membership.role` without a null
    // check, matching `requireMembership`'s old guarantee.
    //
    // Bearer callers carry `effectiveRole` on identity; `membership` on
    // their ctx is whatever `resolveMembership` returned. For bearer the
    // downstream code should prefer `deriveRole(ctx)` + authedCtx.role
    // (which `audit-wrap` derives the same way) rather than poking
    // membership directly.
    const m = ctx.membership;
    if (m === null) {
      // Unreachable for the roles we accept here — customers were already
      // rejected by the role-not-in-allowlist gate above. Keeping the
      // guard so that the `.unstable_pipe` type narrowing is sound at
      // runtime too.
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "insufficient role",
      });
    }
    return next({ ctx: { ...ctx, membership: m } });
  });
}
