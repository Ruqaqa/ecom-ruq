/**
 * Email RTL invariant.
 *
 * Arabic-locale emails must be rendered with `dir="rtl"` on the outer HTML
 * wrapper so RTL-safe clients (Gmail web/mobile, Apple Mail, Outlook) lay
 * out the content correctly. English must render with `dir="ltr"` (or at
 * least without an `rtl` directive) and must carry the English subject /
 * body — not the Arabic copy.
 *
 * We use the same `__setTestTransport` seam the host-spoof test uses.
 * Per CLAUDE.md §1 we do NOT mock sendEmail itself; we capture the
 * outgoing nodemailer payload at the transport boundary.
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

const tenant: Tenant = {
  id: "00000000-0000-0000-0000-0000000000aa",
  slug: "brand-a",
  primaryDomain: "brand-a.com",
  defaultLocale: "en",
  senderEmail: "no-reply@brand-a.com",
  name: { en: "Brand A", ar: "العلامة أ" },
};

describe("sendTenantEmail — RTL / LTR rendering", () => {
  it("Arabic verify-email HTML sets dir=\"rtl\" on the outer wrapper", async () => {
    await sendTenantEmail({
      tenant,
      to: "shopper@example.com",
      locale: "ar",
      template: "verify-email",
      params: { token: "T_AR" },
    });

    expect(captured).toHaveLength(1);
    const html = captured[0]?.html ?? "";
    // dir="rtl" must appear on <html>, <body>, or an outer container.
    expect(html).toMatch(/dir="rtl"/i);
    // Arabic subject uses a distinctive Arabic token; the English subject
    // never contains the Arabic word "تأكيد".
    expect(captured[0]?.subject ?? "").toContain("تأكيد");
    // Body text uses a distinctive Arabic phrase that cannot appear in
    // the English template.
    expect(html).toContain("يرجى تأكيد");
  });

  it("English verify-email HTML sets dir=\"ltr\" (no rtl) and uses English copy", async () => {
    await sendTenantEmail({
      tenant,
      to: "shopper@example.com",
      locale: "en",
      template: "verify-email",
      params: { token: "T_EN" },
    });

    expect(captured).toHaveLength(1);
    const html = captured[0]?.html ?? "";
    expect(html).toMatch(/dir="ltr"/i);
    expect(html).not.toMatch(/dir="rtl"/i);
    expect(captured[0]?.subject ?? "").toContain("Verify");
    // A distinctive English phrase not present in the Arabic template.
    expect(html).toContain("Please confirm your email");
    expect(html).not.toContain("يرجى تأكيد");
  });

  it("Arabic magic-link HTML sets dir=\"rtl\" and uses Arabic CTA / body", async () => {
    await sendTenantEmail({
      tenant,
      to: "shopper@example.com",
      locale: "ar",
      template: "magic-link",
      params: { token: "M_AR", returnTo: "/ar/account" },
    });

    const html = captured[0]?.html ?? "";
    expect(html).toMatch(/dir="rtl"/i);
    expect(captured[0]?.subject ?? "").toContain("رابط الدخول");
    // Arabic-only CTA text.
    expect(html).toContain("تسجيل الدخول");
  });

  it("English magic-link HTML sets dir=\"ltr\" and uses English CTA / body", async () => {
    await sendTenantEmail({
      tenant,
      to: "shopper@example.com",
      locale: "en",
      template: "magic-link",
      params: { token: "M_EN", returnTo: "/en/account" },
    });

    const html = captured[0]?.html ?? "";
    expect(html).toMatch(/dir="ltr"/i);
    expect(html).not.toMatch(/dir="rtl"/i);
    expect(captured[0]?.subject ?? "").toContain("sign-in link");
    expect(html).toContain("Sign in");
    expect(html).not.toContain("تسجيل الدخول");
  });
});
