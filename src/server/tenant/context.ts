/**
 * Branded `AuthedTenantContext` — the only value type `withTenant` will accept.
 *
 * The brand makes `withTenant(db, req.body.tenantId, fn)` a compile-time type
 * error: a raw string can't satisfy `AuthedTenantContext`, and the only way
 * to obtain one is through `buildAuthedTenantContext`, which is called at
 * the tRPC / MCP adapter layer after authentication + tenant resolution.
 *
 * Convention (per architect addendum 3):
 *   - Keep the Phase 0 field set minimal: tenantId + brand only.
 *   - Additional fields (userId, actorType, tokenId, role, ...) land in chunk 6
 *     when the adapter has a real authenticated session to populate them. The
 *     service-layer Tier-B output decisions (prd.md §3.7) and the adapter-
 *     layer audit wrap (M4d) will need them.
 *   - Treat the context as OPAQUE at call sites. Do NOT destructure; pass
 *     through. Only `buildAuthedTenantContext` and `withTenant` read fields.
 *     This keeps chunk 6 a widening of the factory, not a codebase sweep.
 *
 * Rule for nested invocations (enforced in withTenant): flat-only. A service
 * fn that needs DB access takes the existing `tx` argument — never re-enters
 * `withTenant`.
 */
import type { Tenant } from "../tenant";

declare const authedContextBrand: unique symbol;

export type Role = "owner" | "staff" | "support" | "anonymous";

// TODO(chunk 6): replace with the real Better Auth session type and wire
// userId / actorType / tokenId / role into AuthedTenantContext via the
// factory below. Callers do not need to change when this happens.
export interface SessionPlaceholder {
  userId: string | null;
  role: Role;
}

export interface AuthedTenantContext {
  readonly [authedContextBrand]: true;
  readonly tenantId: string;
  // Additional fields added in chunk 6 — intentionally absent here.
  // See the file header for the convention.
}

export function buildAuthedTenantContext(
  resolvedTenant: Pick<Tenant, "id">,
  _session: SessionPlaceholder,
): AuthedTenantContext {
  // `_session` is accepted and will be consumed in chunk 6 to populate
  // userId / actorType / tokenId / role on the returned context. Taking it
  // as a required argument now means chunk 6 does not change the factory
  // signature — only the body.
  return {
    tenantId: resolvedTenant.id,
  } as AuthedTenantContext;
}
