/**
 * tRPC per-request context factory.
 *
 * Reads Host → resolves Tenant → resolves RequestIdentity → resolves
 * Membership. The only error path here is UNKNOWN HOST; everything else
 * (anonymous identity, session with no membership) is a legitimate state
 * that downstream procedures decide how to handle.
 *
 * Anonymous identity is NOT an error — public procedures need to run.
 * `{ session, membership: null }` is NOT an error either — that is a
 * customer (§3.6: users belong to the platform, not a tenant; memberships
 * are admin-only).
 */
import { TRPCError } from "@trpc/server";
import { resolveTenant, type Tenant } from "@/server/tenant";
import {
  resolveRequestIdentity,
  type RequestIdentity,
} from "@/server/auth/resolve-request-identity";
import { resolveMembership, type Membership } from "@/server/auth/membership";

export interface TRPCContext {
  tenant: Tenant;
  identity: RequestIdentity;
  membership: Membership | null;
}

function hostFromRequest(req: Request): string | null {
  // fetchRequestHandler guarantees a well-formed absolute URL; the catch
  // branch is practically unreachable. Fail closed rather than read a
  // potentially proxy-spoofable Host header as a fallback.
  try {
    return new URL(req.url).host.toLowerCase();
  } catch {
    return null;
  }
}

export async function createTRPCContext({ req }: { req: Request }): Promise<TRPCContext> {
  const host = hostFromRequest(req);
  const tenant = await resolveTenant(host);
  if (!tenant) {
    throw new TRPCError({ code: "NOT_FOUND", message: "unknown tenant host" });
  }

  const identity = await resolveRequestIdentity(req.headers, tenant);
  const membership =
    identity.type === "anonymous"
      ? null
      : await resolveMembership(identity.userId, tenant.id);

  return { tenant, identity, membership };
}
