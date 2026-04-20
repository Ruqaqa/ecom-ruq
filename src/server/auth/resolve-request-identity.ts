/**
 * Service-layer identity seam.
 *
 * Chunk 6's tRPC context and chunk 7's MCP adapter both import ONLY:
 *   - `resolveRequestIdentity(headers, tenant)` from here,
 *   - `resolveMembership(userId, tenantId)` from ./membership.
 *
 * Better Auth types MUST NOT leak past this module. That gives us freedom
 * to swap BA for something else later without a codebase sweep, and keeps
 * the service-layer Zod schemas clean.
 *
 * Priority order when both creds are present:
 *   session (cookie) > bearer (PAT). Cookies are only set on the tenant's
 *   own host; bearer is explicit for non-browser clients. When a UI-driven
 *   call accidentally also sets a PAT header (shouldn't happen), we trust
 *   the session.
 *
 * CROSS-TENANT: bearer lookup is scoped to `tenant.id`. A token for
 * tenant A presented on tenant B's domain returns `anonymous`, enforced
 * by `lookupBearerToken`'s `eq(tenant_id, ...)` predicate. Covered by
 * tests/unit/auth/resolve-request-identity.test.ts and -bearer-lookup.test.ts.
 */
import { lookupBearerToken as realLookupBearerToken, type BearerTokenRow } from "./bearer-lookup";
import type { Tenant } from "@/server/tenant";

export type RequestIdentity =
  | { type: "anonymous" }
  | { type: "session"; userId: string; sessionId: string }
  | { type: "bearer"; userId: string; tokenId: string };

// Narrow shape of BA's getSession result — we only read id and userId.
interface SessionLike {
  session: { id: string; userId: string };
  user: { id: string };
}

type SessionProvider = (args: { headers: Headers }) => Promise<SessionLike | null>;
type BearerLookup = (rawToken: string, tenantId: string) => Promise<BearerTokenRow | null>;

let sessionProviderOverride: SessionProvider | null = null;
let bearerLookupOverride: BearerLookup | null = null;

export function __setSessionProviderForTests(p: SessionProvider | null): void {
  sessionProviderOverride = p;
}
export function __setBearerLookupForTests(l: BearerLookup | null): void {
  bearerLookupOverride = l;
}

// Lazy default session provider wiring. We import the auth instance
// dynamically so that this module can load (and its tests can run) even
// when BA hasn't been initialized yet (e.g. in plain unit-test processes
// without secrets). The dynamic import is resolved the first time the
// default is actually called — every test calls `__setSessionProviderForTests`
// before that, so the dynamic path runs only in real server code.
async function defaultSessionProvider(args: { headers: Headers }): Promise<SessionLike | null> {
  const mod = await import("./auth-server");
  const got = await mod.auth.api.getSession({ headers: args.headers });
  if (!got) return null;
  const session = got.session as { id: string; userId: string };
  const user = got.user as { id: string };
  return { session, user };
}

function readBearerToken(headers: Headers): string | null {
  // Headers is case-insensitive; but `new Headers({ AUTHORIZATION: ... })`
  // still works with `.get('authorization')`.
  const raw = headers.get("authorization");
  if (!raw) return null;
  const scheme = raw.slice(0, 7).toLowerCase();
  if (scheme !== "bearer ") return null;
  const token = raw.slice(7).trim();
  return token || null;
}

export async function resolveRequestIdentity(
  headers: Headers,
  tenant: Tenant,
): Promise<RequestIdentity> {
  const sessionProvider = sessionProviderOverride ?? defaultSessionProvider;
  const session = await sessionProvider({ headers });
  if (session) {
    return { type: "session", userId: session.user.id, sessionId: session.session.id };
  }

  const token = readBearerToken(headers);
  if (token) {
    const lookup = bearerLookupOverride ?? realLookupBearerToken;
    const row = await lookup(token, tenant.id);
    if (row) {
      return { type: "bearer", userId: row.userId, tokenId: row.id };
    }
  }

  return { type: "anonymous" };
}
