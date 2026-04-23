/**
 * `deriveRole(ctx)` — the single source of truth for the authenticated
 * caller's Role. This is the adapter-layer value that service functions'
 * Tier-B output gates rely on (see prd.md §3.7 and create-product.ts
 * shape rule #7).
 *
 * Invariants (reviewed at checkpoint 4, security re-reviews on any edit):
 *   - bearer callers carry `effectiveRole` (see resolve-request-identity);
 *     session callers read `membership.role`. The bearer short-circuit is
 *     the S-5 stale-membership fix — a PAT minted as owner for a now-
 *     demoted user resolves as staff at deriveRole. The 7.6.2 `requireRole`
 *     middleware reads through this helper (not `ctx.membership.role`
 *     directly), so the role gate honors the same short-circuit and the
 *     old `requireMembership` blind spot is closed.
 *   - session path: role comes from ctx.membership?.role, with the
 *     customer fallback for session-without-membership (prd.md §3.6).
 *   - anonymous identity → 'anonymous'. Customer session → 'customer'.
 *   - NEVER take a role value from request input, headers, or caller
 *     parameters. That's the Tier-B collapse security flagged — a
 *     future router wiring that accepted a Role literal would silently
 *     elevate callers past the output gate.
 *
 * The `Pick` parameter shape is deliberate: it makes TypeScript refuse
 * to look at any field outside `identity` and `membership`. Adversarial
 * ctx spreads with a top-level `role` field are ignored by construction.
 * Call sites use this helper; there are no inline `ctx.membership?.role`
 * derivations anywhere else in the codebase.
 */
import type { TRPCContext } from "./context";
import type { Role } from "@/server/tenant/context";

export function deriveRole(
  ctx: Pick<TRPCContext, "identity" | "membership">,
): Role {
  // Bearer short-circuit: the PAT-lookup seam already computed
  // `min(scopes.role, membership.role)` and refuses to return at all when
  // membership is gone. For the bearer path, `identity.effectiveRole` IS
  // the role; we must NOT fall through to `membership.role` — that's the
  // S-5 bug the 7.1 security review flagged.
  if (ctx.identity.type === "bearer") return ctx.identity.effectiveRole;
  if (ctx.membership?.role) return ctx.membership.role;
  if (ctx.identity.type === "anonymous") return "anonymous";
  return "customer";
}
