/**
 * `buildAuthedTenantContext` — the adapter-layer factory that constructs
 * the branded `AuthedTenantContext` consumed by `withTenant`. Block 2b
 * widens this shape from the minimal chunk-5 placeholder to include
 * userId, actorType, tokenId, and role so the audit middleware and
 * service-layer Tier-B output gating have real fields to read.
 *
 * Callers never construct the context directly and never destructure it;
 * these tests are the only place we inspect the internal shape.
 */
import { describe, it, expect } from "vitest";
import {
  buildAuthedTenantContext,
  type AuthedSession,
} from "@/server/tenant/context";

const tenantId = "00000000-0000-0000-0000-000000000abc";

function session(overrides: Partial<AuthedSession> = {}): AuthedSession {
  return {
    userId: null,
    actorType: "anonymous",
    tokenId: null,
    role: "anonymous",
    ...overrides,
  };
}

describe("buildAuthedTenantContext (widened)", () => {
  it("anonymous session populates all five fields with nulls + anonymous role", () => {
    const ctx = buildAuthedTenantContext({ id: tenantId }, session());
    expect(ctx).toMatchObject({
      tenantId,
      userId: null,
      actorType: "anonymous",
      tokenId: null,
      role: "anonymous",
    });
  });

  it("customer (session + no membership) carries role='customer'", () => {
    const ctx = buildAuthedTenantContext(
      { id: tenantId },
      session({ userId: "u_customer", actorType: "user", role: "customer" }),
    );
    expect(ctx).toMatchObject({
      tenantId,
      userId: "u_customer",
      actorType: "user",
      tokenId: null,
      role: "customer",
    });
  });

  it("owner membership populates role='owner'", () => {
    const ctx = buildAuthedTenantContext(
      { id: tenantId },
      session({ userId: "u_owner", actorType: "user", role: "owner" }),
    );
    expect(ctx.role).toBe("owner");
    expect(ctx.userId).toBe("u_owner");
    expect(ctx.tokenId).toBeNull();
  });

  it("bearer + owner membership carries the tokenId", () => {
    const ctx = buildAuthedTenantContext(
      { id: tenantId },
      session({
        userId: "u_bearer",
        actorType: "user",
        tokenId: "tok_123",
        role: "owner",
      }),
    );
    expect(ctx).toMatchObject({
      tenantId,
      userId: "u_bearer",
      actorType: "user",
      tokenId: "tok_123",
      role: "owner",
    });
  });
});
