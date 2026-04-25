/**
 * Branded `AuthedTenantContext` — the only value type `withTenant` will accept.
 *
 * The brand makes `withTenant(db, req.body.tenantId, fn)` a compile-time type
 * error: a raw string can't satisfy `AuthedTenantContext`, and the only way
 * to obtain one is through `buildAuthedTenantContext`, which is called at
 * the tRPC / MCP adapter layer after authentication + tenant resolution.
 *
 * Block 2b widens the shape from the chunk-5 placeholder (tenantId + brand
 * only) to the full set the audit middleware and service-layer Tier-B
 * output gating need: userId, actorType, tokenId, role. The factory
 * signature is unchanged — only the body.
 *
 * Convention:
 *   - Treat the context as OPAQUE at call sites. Do NOT destructure; pass
 *     through. Only `buildAuthedTenantContext`, `withTenant`, and the
 *     audit middleware read fields.
 *
 * Rule for nested invocations (enforced in withTenant): flat-only. A service
 * fn that needs DB access takes the existing `tx` argument — never re-enters
 * `withTenant`.
 */
import type { Tenant } from "../tenant";

declare const authedContextBrand: unique symbol;

export type Role = "owner" | "staff" | "support" | "customer" | "anonymous";

export type ActorType = "user" | "system" | "anonymous";

/**
 * The session shape the tRPC and MCP adapters hand to
 * `buildAuthedTenantContext`. Adapters derive this from
 * `resolveRequestIdentity` + `resolveMembership`:
 *   - anonymous identity         → userId null, actorType 'anonymous', role 'anonymous'
 *   - session identity + no row  → actorType 'user', role 'customer'
 *   - session identity + row     → actorType 'user', role = membership.role
 *   - bearer identity + row      → actorType 'user', tokenId set, role = membership.role
 * `'system'` is reserved for chunk-7 cron/internal-job callers; the tRPC
 * middleware never constructs it.
 */
export interface AuthedSession {
  userId: string | null;
  actorType: ActorType;
  tokenId: string | null;
  role: Role;
}

export interface AuthedTenantContext {
  readonly [authedContextBrand]: true;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly actorType: ActorType;
  readonly tokenId: string | null;
  readonly role: Role;
}

export function buildAuthedTenantContext(
  resolvedTenant: Pick<Tenant, "id">,
  session: AuthedSession,
): AuthedTenantContext {
  return {
    tenantId: resolvedTenant.id,
    userId: session.userId,
    actorType: session.actorType,
    tokenId: session.tokenId,
    role: session.role,
  } as AuthedTenantContext;
}

export function isWriteRole(role: Role): boolean {
  return role === "owner" || role === "staff";
}
