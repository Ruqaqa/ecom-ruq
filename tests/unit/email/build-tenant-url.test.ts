/**
 * `buildTenantUrl(tenant, locale, path, query)` produces a URL bound to the
 * tenant's primaryDomain — never to the request Host. The function is pure:
 * it takes an already-resolved Tenant and never reads env or headers.
 */
import { describe, it, expect } from "vitest";
import { buildTenantUrl } from "@/server/email/send-tenant-email";
import type { Tenant } from "@/server/tenant";

function tenant(primaryDomain: string): Tenant {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    slug: "x",
    primaryDomain,
    defaultLocale: "ar",
    senderEmail: `no-reply@${primaryDomain}`,
    name: { en: "X", ar: "س" },
  };
}

describe("buildTenantUrl", () => {
  it("uses localhost:5001 with http in dev-style hosts", () => {
    const url = buildTenantUrl(tenant("localhost:5001"), "en", "/verify-email", { token: "abc" });
    expect(url).toBe("http://localhost:5001/en/verify-email?token=abc");
  });

  it("uses https for non-localhost hosts", () => {
    const url = buildTenantUrl(tenant("brand-a.com"), "en", "/verify-email", { token: "abc" });
    expect(url).toBe("https://brand-a.com/en/verify-email?token=abc");
  });

  it("renders Arabic paths with locale prefix and query", () => {
    const url = buildTenantUrl(tenant("brand-b.com"), "ar", "/reset-password", {
      token: "t1",
      returnTo: "/ar/account",
    });
    expect(url).toContain("https://brand-b.com/ar/reset-password?");
    expect(url).toContain("token=t1");
    expect(url).toContain("returnTo=%2Far%2Faccount");
  });

  it("tenants with different primaryDomain produce different URLs for identical inputs", () => {
    const a = buildTenantUrl(tenant("brand-a.com"), "en", "/x", { token: "t" });
    const b = buildTenantUrl(tenant("brand-b.com"), "en", "/x", { token: "t" });
    expect(a).not.toBe(b);
    expect(a).toContain("brand-a.com");
    expect(b).toContain("brand-b.com");
    expect(a).not.toContain("brand-b.com");
    expect(b).not.toContain("brand-a.com");
  });

  it("throws if primaryDomain is empty (programmer error — Tenant should never carry empty)", () => {
    expect(() =>
      buildTenantUrl(tenant(""), "en", "/x", { token: "t" }),
    ).toThrow();
  });

  it("supports both en and ar parametrically", () => {
    for (const locale of ["en", "ar"] as const) {
      const url = buildTenantUrl(tenant("brand-a.com"), locale, "/sign-in", { token: "T" });
      expect(url).toBe(`https://brand-a.com/${locale}/sign-in?token=T`);
    }
  });
});
