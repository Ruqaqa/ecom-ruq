/**
 * MCP identity seam — sub-chunk 7.2.
 *
 * Mirror of `resolveRequestIdentity` but non-browser:
 *   - MCP is invoked by Claude Desktop / Code / autonomous agents —
 *     non-browser clients that CANNOT carry session cookies (per ADR 0001
 *     option (b): BA's `bearer` plugin is a session-cookie shim, not a
 *     PAT hasher). The only valid auth channel here is
 *     `Authorization: Bearer <raw-PAT>`.
 *   - Sessions are NOT consulted. If a future caller smuggles a session
 *     cookie AND a bearer, the bearer wins (and cookies never reach this
 *     seam because MCP traffic does not share the browser origin).
 *
 * Behavior:
 *   - no Authorization header → `{ type: "anonymous" }`.
 *   - Bearer header present → `lookupBearerToken(raw, tenant.id)`. Row
 *     null for any reason (cross-tenant, revoked, expired, stale-
 *     membership, S-5 demotion, unknown pepper) → `{ type: "anonymous" }`.
 *     Row found → `{ type: "bearer", userId, tokenId, role: effectiveRole,
 *     scopes }`.
 *
 * Anonymous MUST be rejected by the HTTP route BEFORE tool dispatch (see
 * block 6 — `src/app/api/mcp/[transport]/route.ts`). This module only
 * classifies; it does not gate.
 *
 * The bearer lookup override is LOCAL to this module (NOT shared with
 * resolve-request-identity's override). Two separate test surfaces means
 * two separate override globals; otherwise a misconfigured test spy on
 * the tRPC seam would silently flip MCP behavior.
 */
import { lookupBearerToken as realLookupBearerToken, type BearerTokenRow } from "@/server/auth/bearer-lookup";
import type { MembershipRole } from "@/server/auth/membership";

export type McpIdentity =
  | { type: "anonymous" }
  | {
      type: "bearer";
      userId: string;
      tokenId: string;
      role: MembershipRole;
      /**
       * Raw `access_tokens.scopes` JSON. Kept as `unknown` at this seam —
       * downstream consumers (tool visibility / authorize) must narrow it
       * through their own Zod. Never parsed for `role` here; role is
       * ctx.identity.role, already demoted via the lookup's min-merge.
       */
      scopes: unknown;
    };

type BearerLookup = (rawToken: string, tenantId: string) => Promise<BearerTokenRow | null>;

let bearerLookupOverride: BearerLookup | null = null;

/**
 * Test-only seam. Separate from `resolve-request-identity`'s override
 * (which the tRPC seam uses). Pass null to restore the default.
 */
export function __setBearerLookupForTests(l: BearerLookup | null): void {
  bearerLookupOverride = l;
}

function readBearerToken(headers: Headers): string | null {
  const raw = headers.get("authorization");
  if (!raw) return null;
  const scheme = raw.slice(0, 7).toLowerCase();
  if (scheme !== "bearer ") return null;
  const token = raw.slice(7).trim();
  return token || null;
}

export async function resolveMcpIdentity(
  headers: Headers,
  tenant: { id: string },
): Promise<McpIdentity> {
  const token = readBearerToken(headers);
  if (!token) return { type: "anonymous" };

  const lookup = bearerLookupOverride ?? realLookupBearerToken;
  const row = await lookup(token, tenant.id);
  if (!row) return { type: "anonymous" };

  return {
    type: "bearer",
    userId: row.userId,
    tokenId: row.id,
    role: row.effectiveRole,
    scopes: row.scopes,
  };
}
