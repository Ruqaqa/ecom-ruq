/**
 * HOST-SPOOF SECURITY TEST (top priority).
 *
 * The invariant: sendTenantEmail renders links against the resolved tenant's
 * primaryDomain. An attacker who controls the HTTP Host header MUST NOT be
 * able to poison reset / verify / magic links.
 *
 * We capture the outgoing Nodemailer message via a stub transport and assert:
 *   - the body contains the tenant's real primaryDomain
 *   - the body contains the tenant's real senderEmail as From
 *   - no occurrence of the spoofed host anywhere in the body
 *
 * The fact that sendTenantEmail's public signature accepts a `tenant: Tenant`
 * (not a Headers / Host string) is itself the first line of defense — no
 * Host value can reach the link-building path without a caller explicitly
 * constructing a Tenant object, which the resolver refuses to do for an
 * attacker-controlled unknown host.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sendTenantEmail, __setTestTransport } from "@/server/email/send-tenant-email";
import type { Tenant } from "@/server/tenant";

interface CapturedMessage {
  from?: string;
  to?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
}

const captured: CapturedMessage[] = [];

beforeEach(() => {
  captured.length = 0;
  __setTestTransport({
    async sendMail(msg: CapturedMessage) {
      captured.push(msg);
      return { messageId: "test" };
    },
  });
});

afterEach(() => {
  __setTestTransport(null);
});

const brandA: Tenant = {
  id: "00000000-0000-0000-0000-0000000000aa",
  slug: "brand-a",
  primaryDomain: "brand-a.com",
  defaultLocale: "en",
  senderEmail: "no-reply@brand-a.com",
  name: { en: "Brand A", ar: "العلامة أ" },
};

describe("sendTenantEmail — host-spoof defense", () => {
  it("renders the body against tenant.primaryDomain regardless of any Host-like inputs", async () => {
    // The production API does NOT accept a Host. But even if a caller has
    // access to a spoofed request, the signature forces them to resolve
    // a Tenant first — and the resolver rejects unknown hosts. Here we
    // simulate that end state: the tenant is the real one; no Host input
    // is passed; the body must reflect that.
    await sendTenantEmail({
      tenant: brandA,
      to: "shopper@example.com",
      locale: "en",
      template: "verify-email",
      params: { token: "VERIFY_TOKEN_123" },
    });

    expect(captured).toHaveLength(1);
    const msg = captured[0];
    expect(msg).toBeDefined();
    if (!msg) return;
    expect(msg.from).toBe("no-reply@brand-a.com");
    expect(msg.to).toBe("shopper@example.com");

    const body = `${msg.html ?? ""}\n${msg.text ?? ""}`;

    expect(body).toContain("brand-a.com");
    expect(body).toContain("VERIFY_TOKEN_123");

    expect(body).not.toContain("attacker.com");
    expect(body).not.toContain("brand-b.com");
  });

  it("renders magic-link body against tenant.primaryDomain, not attacker host", async () => {
    await sendTenantEmail({
      tenant: brandA,
      to: "shopper@example.com",
      locale: "ar",
      template: "magic-link",
      params: { token: "MAGIC_TOKEN_XYZ", returnTo: "/ar/cart" },
    });

    const msg = captured[0];
    expect(msg).toBeDefined();
    if (!msg) return;
    const body = `${msg.html ?? ""}\n${msg.text ?? ""}`;
    expect(body).toContain("https://brand-a.com/api/auth/magic-link/verify");
    expect(body).toContain("MAGIC_TOKEN_XYZ");
    expect(body).toContain("callbackURL");
    expect(body).not.toContain("attacker.com");
    expect(msg.from).toBe("no-reply@brand-a.com");
  });

  it("different tenants (same process) produce links against their own domains", async () => {
    const brandB: Tenant = { ...brandA, primaryDomain: "brand-b.com", senderEmail: "no-reply@brand-b.com", slug: "brand-b" };
    await sendTenantEmail({
      tenant: brandA,
      to: "a@example.com",
      locale: "en",
      template: "verify-email",
      params: { token: "T_A" },
    });
    await sendTenantEmail({
      tenant: brandB,
      to: "b@example.com",
      locale: "en",
      template: "verify-email",
      params: { token: "T_B" },
    });

    expect(captured).toHaveLength(2);
    const bodyA = `${captured[0]?.html ?? ""}\n${captured[0]?.text ?? ""}`;
    const bodyB = `${captured[1]?.html ?? ""}\n${captured[1]?.text ?? ""}`;

    expect(bodyA).toContain("brand-a.com");
    expect(bodyA).not.toContain("brand-b.com");
    expect(bodyB).toContain("brand-b.com");
    expect(bodyB).not.toContain("brand-a.com");
  });
});
