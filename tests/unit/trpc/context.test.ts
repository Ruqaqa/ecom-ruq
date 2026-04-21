/**
 * `createTRPCContext({ req })` — the per-request tRPC context factory.
 *
 * Contract:
 *   - Host is read from `new URL(req.url).host.toLowerCase()`, matching the
 *     pattern in auth-server.ts' hostFromRequest.
 *   - Unknown host => throws TRPCError with code NOT_FOUND. This is the
 *     only error path at this layer; everything else is policy that
 *     individual procedures enforce downstream.
 *   - Anonymous identity is NOT an error. A session with no membership
 *     (customer) is NOT an error — membership is null in that case.
 *
 * Seams used:
 *   - `__setTenantLookupLoaderForTests` from @/server/tenant
 *   - `__setSessionProviderForTests`, `__setBearerLookupForTests` from
 *     @/server/auth/resolve-request-identity
 *   - `__setMembershipDbForTests` from @/server/auth/membership — passed a
 *     stub AppDb whose `.select(...).from(...).where(...).limit(1)` chain
 *     returns the membership row we want (or none).
 */
import { describe, it, expect, afterEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { createTRPCContext } from "@/server/trpc/context";
import {
  __setTenantLookupLoaderForTests,
  clearTenantCacheForTests,
  type Tenant,
} from "@/server/tenant";
import {
  __setSessionProviderForTests,
  __setBearerLookupForTests,
} from "@/server/auth/resolve-request-identity";
import { __setMembershipDbForTests } from "@/server/auth/membership";
import type { AppDb } from "@/server/db";

const knownHost = "shop.local";

const tenant: Tenant = {
  id: "00000000-0000-0000-0000-0000000000aa",
  slug: "a",
  primaryDomain: knownHost,
  defaultLocale: "en",
  senderEmail: "no-reply@shop.local",
  name: { en: "Shop", ar: "متجر" },
};

function makeReq(host: string): Request {
  return new Request(`http://${host}/api/trpc/foo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

/**
 * Builds a minimal AppDb stand-in whose select().from().where().limit()
 * chain resolves to the rows passed in. resolveMembership is the only
 * consumer of this chain in the code under test.
 */
function stubMembershipDb(rows: unknown[]): AppDb {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain } as unknown as AppDb;
}

afterEach(() => {
  __setTenantLookupLoaderForTests(null);
  __setSessionProviderForTests(null);
  __setBearerLookupForTests(null);
  __setMembershipDbForTests(null);
  clearTenantCacheForTests();
});

describe("createTRPCContext", () => {
  it("returns anonymous identity and null membership for a known host with no creds", async () => {
    __setTenantLookupLoaderForTests(async () => tenant);
    __setSessionProviderForTests(async () => null);
    __setBearerLookupForTests(async () => null);
    __setMembershipDbForTests(stubMembershipDb([]));

    const ctx = await createTRPCContext({ req: makeReq(knownHost) });

    expect(ctx.tenant.id).toBe(tenant.id);
    expect(ctx.identity).toEqual({ type: "anonymous" });
    expect(ctx.membership).toBeNull();
  });

  it("returns session identity with null membership for a customer (no memberships row)", async () => {
    __setTenantLookupLoaderForTests(async () => tenant);
    __setSessionProviderForTests(async () => ({
      session: { id: "sess_1", userId: "user_1" },
      user: { id: "user_1" },
    }));
    __setBearerLookupForTests(async () => null);
    __setMembershipDbForTests(stubMembershipDb([]));

    const ctx = await createTRPCContext({ req: makeReq(knownHost) });

    expect(ctx.identity).toEqual({ type: "session", userId: "user_1", sessionId: "sess_1" });
    expect(ctx.membership).toBeNull();
  });

  it("returns session identity with owner membership when memberships row exists", async () => {
    __setTenantLookupLoaderForTests(async () => tenant);
    __setSessionProviderForTests(async () => ({
      session: { id: "sess_2", userId: "user_2" },
      user: { id: "user_2" },
    }));
    __setBearerLookupForTests(async () => null);
    __setMembershipDbForTests(
      stubMembershipDb([
        { id: "m_1", role: "owner", userId: "user_2", tenantId: tenant.id },
      ]),
    );

    const ctx = await createTRPCContext({ req: makeReq(knownHost) });

    expect(ctx.identity.type).toBe("session");
    expect(ctx.membership).not.toBeNull();
    expect(ctx.membership?.role).toBe("owner");
  });

  it("throws TRPCError NOT_FOUND on an unknown host", async () => {
    __setTenantLookupLoaderForTests(async () => null);

    await expect(createTRPCContext({ req: makeReq("unknown.invalid") })).rejects.toSatisfy(
      (err) => err instanceof TRPCError && (err as TRPCError).code === "NOT_FOUND",
    );
  });
});
