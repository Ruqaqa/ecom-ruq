/**
 * `deriveRole(ctx)` — the single source of truth for the authenticated
 * caller's Role. This is the adapter-layer value that service functions'
 * Tier-B output gates rely on (see prd.md §3.7 and create-product.ts
 * shape rule #7).
 *
 * Invariants (reviewed at checkpoint 4, security re-reviews on any edit):
 *   - role comes EXCLUSIVELY from ctx.membership?.role, with the
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
  if (ctx.membership?.role) return ctx.membership.role;
  if (ctx.identity.type === "anonymous") return "anonymous";
  return "customer";
}
