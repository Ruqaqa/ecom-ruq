/**
 * `resolveRequestIdentity(headers, tenant)` — the service-layer seam that
 * chunk 6's tRPC context and chunk 7's MCP adapter both consume.
 *
 * Contract:
 *   - cookie path: delegates to `auth.api.getSession({ headers })`. If BA
 *     returns a session, return `{ type: 'session', userId, sessionId }`.
 *   - bearer path: reads `Authorization: Bearer <token>` header (case-
 *     insensitive) and calls `lookupBearerToken(rawToken, tenant.id)`. If
 *     the lookup returns a row, return `{ type: 'bearer', userId, tokenId }`.
 *     CROSS-TENANT: a bearer token for tenant A presented against tenant B
 *     returns `anonymous`, not cross-tenant authenticated. This is the
 *     load-bearing security test.
 *   - no creds: `{ type: 'anonymous' }`.
 *
 * We inject both the BA stand-in and the bearer lookup so the unit test
 * does not spin up BA or hit the real access_tokens table for every case.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  resolveRequestIdentity,
  __setSessionProviderForTests,
  __setBearerLookupForTests,
} from "@/server/auth/resolve-request-identity";
import type { Tenant } from "@/server/tenant";

const tenantA: Tenant = {
  id: "00000000-0000-0000-0000-0000000000aa",
  slug: "a",
  primaryDomain: "a.local",
  defaultLocale: "en",
  senderEmail: "no-reply@a.local",
  name: { en: "A", ar: "أ" },
};

const tenantB: Tenant = { ...tenantA, id: "00000000-0000-0000-0000-0000000000bb", primaryDomain: "b.local", slug: "b" };

afterEach(() => {
  __setSessionProviderForTests(null);
  __setBearerLookupForTests(null);
});

describe("resolveRequestIdentity", () => {
  it("returns anonymous when no credentials are present", async () => {
    __setSessionProviderForTests(async () => null);
    __setBearerLookupForTests(async () => null);
    const id = await resolveRequestIdentity(new Headers(), tenantA);
    expect(id).toEqual({ type: "anonymous" });
  });

  it("returns session identity when BA resolves a session cookie", async () => {
    __setSessionProviderForTests(async () => ({
      session: { id: "sess-1", userId: "user-1" },
      user: { id: "user-1" },
    }));
    __setBearerLookupForTests(async () => null);

    const headers = new Headers({ cookie: "better-auth.session_token=abc" });
    const id = await resolveRequestIdentity(headers, tenantA);
    expect(id).toEqual({ type: "session", userId: "user-1", sessionId: "sess-1" });
  });

  it("returns bearer identity when the Authorization header matches a tenant-scoped PAT (owner)", async () => {
    __setSessionProviderForTests(async () => null);
    __setBearerLookupForTests(async (token, tenantId) => {
      if (token === "eruq_pat_good" && tenantId === tenantA.id) {
        return {
          id: "tok-1",
          userId: "user-2",
          tenantId: tenantA.id,
          name: "t",
          scopes: {},
          effectiveRole: "owner" as const,
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date(),
        };
      }
      return null;
    });

    const headers = new Headers({ authorization: "Bearer eruq_pat_good" });
    const id = await resolveRequestIdentity(headers, tenantA);
    expect(id).toEqual({
      type: "bearer",
      userId: "user-2",
      tokenId: "tok-1",
      effectiveRole: "owner",
    });
  });

  it("threads the lookup row's `effectiveRole` through to the bearer identity (S-5)", async () => {
    // The PAT-lookup seam already collapsed scopes.role + membership.role
    // to `effectiveRole`. resolveRequestIdentity must not re-compute role;
    // it passes the lookup's answer through verbatim so deriveRole's bearer
    // short-circuit has the right value.
    __setSessionProviderForTests(async () => null);
    __setBearerLookupForTests(async () => ({
      id: "tok-staff",
      userId: "user-demoted",
      tenantId: tenantA.id,
      name: "t",
      scopes: { role: "owner" }, // minted as owner …
      effectiveRole: "staff" as const, // … but membership demoted → staff.
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    }));

    const headers = new Headers({ authorization: "Bearer eruq_pat_demoted" });
    const id = await resolveRequestIdentity(headers, tenantA);
    expect(id).toEqual({
      type: "bearer",
      userId: "user-demoted",
      tokenId: "tok-staff",
      effectiveRole: "staff",
    });
  });

  it("CROSS-TENANT: a token scoped to tenant A is treated as anonymous on tenant B", async () => {
    __setSessionProviderForTests(async () => null);
    const lookup = vi.fn(async (_token: string, tenantId: string) => {
      if (tenantId === tenantA.id) {
        return {
          id: "tok-A",
          userId: "user-X",
          tenantId: tenantA.id,
          name: "t",
          scopes: {},
          effectiveRole: "owner" as const,
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date(),
        };
      }
      return null;
    });
    __setBearerLookupForTests(lookup);

    const headers = new Headers({ authorization: "Bearer eruq_pat_xyz" });
    const idOnB = await resolveRequestIdentity(headers, tenantB);
    expect(idOnB).toEqual({ type: "anonymous" });
    expect(lookup).toHaveBeenCalledWith("eruq_pat_xyz", tenantB.id);
  });

  it("treats the authorization header case-insensitively", async () => {
    __setSessionProviderForTests(async () => null);
    __setBearerLookupForTests(async () => ({
      id: "tok-1",
      userId: "user-2",
      tenantId: tenantA.id,
      name: "t",
      scopes: {},
      effectiveRole: "owner" as const,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    }));
    const headers = new Headers({ AUTHORIZATION: "bearer eruq_pat_good" });
    const id = await resolveRequestIdentity(headers, tenantA);
    expect(id.type).toBe("bearer");
  });

  it("ignores a non-bearer Authorization scheme", async () => {
    __setSessionProviderForTests(async () => null);
    const lookup = vi.fn();
    __setBearerLookupForTests(lookup);
    const headers = new Headers({ authorization: "Basic YWRtaW46" });
    const id = await resolveRequestIdentity(headers, tenantA);
    expect(id).toEqual({ type: "anonymous" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("prefers session over bearer when both are present", async () => {
    __setSessionProviderForTests(async () => ({
      session: { id: "sess-1", userId: "user-session" },
      user: { id: "user-session" },
    }));
    __setBearerLookupForTests(async () => ({
      id: "tok-1",
      userId: "user-bearer",
      tenantId: tenantA.id,
      name: "t",
      scopes: {},
      effectiveRole: "owner" as const,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    }));
    const headers = new Headers({
      cookie: "better-auth.session_token=abc",
      authorization: "Bearer eruq_pat_good",
    });
    const id = await resolveRequestIdentity(headers, tenantA);
    expect(id).toEqual({ type: "session", userId: "user-session", sessionId: "sess-1" });
  });
});
