/**
 * `resolveMcpIdentity(headers, tenant)` — MCP auth seam. Sessions are
 * NEVER consulted here; MCP is non-browser. A cookie-carrying request
 * that somehow reaches MCP ignores the cookie and falls through to
 * anonymous unless a valid Bearer token is also present.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  resolveMcpIdentity,
  __setBearerLookupForTests,
} from "@/server/mcp/identity";
import type { BearerTokenRow } from "@/server/auth/bearer-lookup";

const tenantA = { id: "00000000-0000-0000-0000-0000000000aa" };
const tenantB = { id: "00000000-0000-0000-0000-0000000000bb" };

function row(overrides: Partial<BearerTokenRow> = {}): BearerTokenRow {
  return {
    id: "tok-1",
    userId: "user-1",
    tenantId: tenantA.id,
    name: "test",
    scopes: { role: "owner", tools: ["ping"] },
    effectiveRole: "owner",
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

afterEach(() => {
  __setBearerLookupForTests(null);
});

describe("resolveMcpIdentity", () => {
  it("returns anonymous when no Authorization header is present", async () => {
    __setBearerLookupForTests(async () => null);
    const id = await resolveMcpIdentity(new Headers(), tenantA);
    expect(id).toEqual({ type: "anonymous" });
  });

  it("returns a bearer identity with role=effectiveRole and the raw scopes on happy path", async () => {
    __setBearerLookupForTests(async () => row({ effectiveRole: "owner" }));
    const headers = new Headers({ authorization: "Bearer eruq_pat_ok" });
    const id = await resolveMcpIdentity(headers, tenantA);
    expect(id).toEqual({
      type: "bearer",
      userId: "user-1",
      tokenId: "tok-1",
      role: "owner",
      scopes: { role: "owner", tools: ["ping"] },
    });
  });

  it("does NOT consult the session provider even if one is somehow visible (non-browser transport)", async () => {
    // The identity module does not import the session path. This test
    // guards the module boundary: we exercise cookies-without-bearer
    // and confirm anonymous (not session). If a future refactor imports
    // resolve-request-identity here, this test will red-line because
    // the cookie header would resolve to session.
    __setBearerLookupForTests(async () => null);
    const headers = new Headers({ cookie: "better-auth.session_token=abc" });
    const id = await resolveMcpIdentity(headers, tenantA);
    expect(id).toEqual({ type: "anonymous" });
  });

  it("cross-tenant reject — token for tenantA presented on tenantB falls through to anonymous", async () => {
    const lookup = vi.fn(async (_t: string, tenantId: string) => {
      if (tenantId === tenantA.id) return row();
      return null;
    });
    __setBearerLookupForTests(lookup);
    const headers = new Headers({ authorization: "Bearer eruq_pat_cross" });
    const id = await resolveMcpIdentity(headers, tenantB);
    expect(id).toEqual({ type: "anonymous" });
    expect(lookup).toHaveBeenCalledWith("eruq_pat_cross", tenantB.id);
  });

  it("revoked row — lookup returns null → anonymous", async () => {
    // lookupBearerToken already filters revoked rows (isNull(revokedAt)).
    // The MCP seam inherits that — null means anonymous.
    __setBearerLookupForTests(async () => null);
    const headers = new Headers({ authorization: "Bearer eruq_pat_revoked" });
    const id = await resolveMcpIdentity(headers, tenantA);
    expect(id).toEqual({ type: "anonymous" });
  });

  it("expired row — lookup returns null → anonymous", async () => {
    __setBearerLookupForTests(async () => null);
    const headers = new Headers({ authorization: "Bearer eruq_pat_exp" });
    const id = await resolveMcpIdentity(headers, tenantA);
    expect(id).toEqual({ type: "anonymous" });
  });

  it("stale-membership — lookup returns null (INNER JOIN dropped) → anonymous", async () => {
    // S-5: if the user's membership row was deleted, the inner join in
    // lookupBearerToken drops the result to null.
    __setBearerLookupForTests(async () => null);
    const headers = new Headers({ authorization: "Bearer eruq_pat_stale" });
    const id = await resolveMcpIdentity(headers, tenantA);
    expect(id).toEqual({ type: "anonymous" });
  });

  it("scopes-demoted role — PAT minted as owner, membership=staff → role='staff' (S-5)", async () => {
    __setBearerLookupForTests(async () =>
      row({
        scopes: { role: "owner" },     // minted as owner …
        effectiveRole: "staff",          // … membership demoted → staff
      }),
    );
    const headers = new Headers({ authorization: "Bearer eruq_pat_demoted" });
    const id = await resolveMcpIdentity(headers, tenantA);
    expect(id).toMatchObject({ type: "bearer", role: "staff" });
    // raw scopes field is preserved — downstream tools that gate on
    // `scopes.tools` still see the original permission list, even if role
    // was demoted.
    expect((id as { scopes: { role: string } }).scopes).toEqual({ role: "owner" });
  });

  it("ignores non-bearer schemes (Basic auth) → anonymous", async () => {
    const lookup = vi.fn();
    __setBearerLookupForTests(lookup);
    const headers = new Headers({ authorization: "Basic YWRtaW46" });
    const id = await resolveMcpIdentity(headers, tenantA);
    expect(id).toEqual({ type: "anonymous" });
    expect(lookup).not.toHaveBeenCalled();
  });
});
