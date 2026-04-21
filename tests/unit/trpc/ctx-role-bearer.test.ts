/**
 * `deriveRole(ctx)` bearer short-circuit — sub-chunk 7.2 / S-5.
 *
 * Contract: a bearer caller's role derives from `ctx.identity.effectiveRole`,
 * which the PAT-lookup seam already computed as
 * `min(scopes.role, membership.role)`. deriveRole must NOT fall through to
 * `ctx.membership?.role` for bearer callers. The adversarial scenario is:
 *   - bearer identity with effectiveRole='staff'
 *   - BUT ctx.membership?.role='owner' (e.g. a bug in ctx assembly)
 * The short-circuit ensures we return 'staff', not 'owner'. The 7.1
 * security review flagged this as the S-5 exploitable path.
 *
 * Scenario-8 (adversarial ctx-spread) lives in the sibling ctx-role.test.ts.
 */
import { describe, it, expect } from "vitest";
import { deriveRole } from "@/server/trpc/ctx-role";

describe("deriveRole — bearer short-circuit (S-5)", () => {
  it("1. owner user + owner-scoped PAT → 'owner'", () => {
    const role = deriveRole({
      identity: { type: "bearer", userId: "u1", tokenId: "t1", effectiveRole: "owner" },
      membership: { id: "m1", role: "owner", userId: "u1", tenantId: "tn1" },
    });
    expect(role).toBe("owner");
  });

  it("2. owner user + staff-scoped PAT → 'staff' (the bug being fixed — caller can't mint above PAT scope)", () => {
    // Pre-7.2 this returned 'owner' because deriveRole read
    // ctx.membership?.role instead of ctx.identity.effectiveRole.
    const role = deriveRole({
      identity: { type: "bearer", userId: "u1", tokenId: "t2", effectiveRole: "staff" },
      membership: { id: "m1", role: "owner", userId: "u1", tenantId: "tn1" },
    });
    expect(role).toBe("staff");
  });

  it("3. staff user + owner-scoped PAT → 'staff' (S-5: lookup demotes to min, short-circuit reads demoted role)", () => {
    // The PAT-lookup layer computes effectiveRole = min('owner','staff') = 'staff'.
    // deriveRole consumes whatever lookup returns; the lookup has already done
    // the demotion. This test pins that end-to-end semantic.
    const role = deriveRole({
      identity: { type: "bearer", userId: "u2", tokenId: "t3", effectiveRole: "staff" },
      membership: { id: "m2", role: "staff", userId: "u2", tenantId: "tn1" },
    });
    expect(role).toBe("staff");
  });

  it("4. adversarial: bearer + membership='owner' but effectiveRole='staff' → 'staff' (scope wins, short-circuits membership)", () => {
    // Locks the short-circuit ordering: even if ctx.membership contains a
    // stale / hostile 'owner' row, the bearer path must ignore it.
    const role = deriveRole({
      identity: { type: "bearer", userId: "u3", tokenId: "t4", effectiveRole: "staff" },
      membership: { id: "m3", role: "owner", userId: "u3", tenantId: "tn1" },
    });
    expect(role).toBe("staff");
  });

  it("5. session + owner membership → 'owner' (regression — session path unchanged)", () => {
    const role = deriveRole({
      identity: { type: "session", userId: "u4", sessionId: "s4" },
      membership: { id: "m4", role: "owner", userId: "u4", tenantId: "tn1" },
    });
    expect(role).toBe("owner");
  });

  it("6. session + no membership → 'customer' (regression — customer fallback unchanged)", () => {
    const role = deriveRole({
      identity: { type: "session", userId: "u5", sessionId: "s5" },
      membership: null,
    });
    expect(role).toBe("customer");
  });

  it("7. anonymous → 'anonymous' (regression — anonymous unchanged)", () => {
    const role = deriveRole({
      identity: { type: "anonymous" },
      membership: null,
    });
    expect(role).toBe("anonymous");
  });
});
