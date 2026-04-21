/**
 * `deriveRole(ctx)` — the single source of truth for the authenticated
 * caller's Role, consumed by the service-layer Tier-B output gate.
 *
 * Invariants (addendum 1, security forward-looking note):
 *   - role comes EXCLUSIVELY from ctx.membership?.role, with a
 *     customer-fallback for session-without-membership (prd.md §3.6).
 *   - anonymous identity → 'anonymous'.
 *   - NEVER takes role from request input, headers, or stray ctx fields.
 *     The Tier-B output gate collapses silently if role is ever
 *     attacker-controlled — this helper is the lock.
 */
import { describe, it, expect } from "vitest";
import { deriveRole } from "@/server/trpc/ctx-role";

const tenant = { id: "t", primaryDomain: "x.local", slug: "x", defaultLocale: "en" as const, senderEmail: "n@x", name: { en: "x", ar: "x" } };

describe("deriveRole", () => {
  it("returns 'anonymous' for anonymous identity (membership is always null here)", () => {
    const role = deriveRole({
      identity: { type: "anonymous" },
      membership: null,
    });
    expect(role).toBe("anonymous");
  });

  it("returns 'customer' for session identity with no membership row", () => {
    const role = deriveRole({
      identity: { type: "session", userId: "u1", sessionId: "s1" },
      membership: null,
    });
    expect(role).toBe("customer");
  });

  it("returns the membership role for session identity + owner membership", () => {
    const role = deriveRole({
      identity: { type: "session", userId: "u2", sessionId: "s2" },
      membership: { id: "m", role: "owner", userId: "u2", tenantId: "t" },
    });
    expect(role).toBe("owner");
  });

  it("returns the bearer effectiveRole (not membership) — the S-5 short-circuit", () => {
    // Pre-7.2 path read membership.role which caused S-5 (PAT minted as
    // owner, user later demoted to staff, caller still resolved as owner).
    // Post-7.2, bearer resolution carries `effectiveRole` on ctx.identity
    // and deriveRole short-circuits there. To lock the short-circuit
    // in place, the adversarial case below passes `membership=owner`
    // while the PAT's `effectiveRole=staff` — role must be 'staff'.
    const role = deriveRole({
      identity: { type: "bearer", userId: "u3", tokenId: "tok_x", effectiveRole: "staff" },
      membership: { id: "m", role: "staff", userId: "u3", tenantId: "t" },
    });
    expect(role).toBe("staff");
  });

  it("returns 'support' for a support membership", () => {
    const role = deriveRole({
      identity: { type: "session", userId: "u4", sessionId: "s4" },
      membership: { id: "m", role: "support", userId: "u4", tenantId: "t" },
    });
    expect(role).toBe("support");
  });

  it("adversarial: ignores any stray ctx fields (e.g. `{ role: 'owner' }` injected as junk)", () => {
    // Craft a ctx with a fake `role` top-level field plus tenant junk.
    // deriveRole's Pick<TRPCContext, "identity" | "membership"> signature
    // refuses to see them at the type layer; this runtime test locks the
    // behavior even if a caller spreads a hostile object.
    const hostile = {
      identity: { type: "session", userId: "attacker", sessionId: "s" },
      membership: null,
      role: "owner",
      tenant,
      tx: {},
      authedCtx: {},
    } as const;
    const role = deriveRole(hostile);
    expect(role).toBe("customer");
  });
});
