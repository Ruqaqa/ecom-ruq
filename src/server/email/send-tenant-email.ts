/**
 * Tenant-aware transactional email sender.
 *
 * The function signature is the security boundary. Callers pass a RESOLVED
 * `Tenant` — not a Host header, not a raw URL, not a request. The resolver
 * rejects unknown hosts, so no attacker-controlled Host value can ever reach
 * link construction. That is why this module exports a single policy
 * function, not an `EmailSender` interface — the type system, not discipline,
 * enforces the rule.
 *
 * Transport: nodemailer SMTP against Mailpit (SMTP_HOST/SMTP_PORT). Mailpit
 * listens on 51025 in local dev and gets the Coolify-provisioned Mailpit in
 * staging. In production, SMTP_HOST points at the real transactional-email
 * provider. Ship the same code path across all three environments so dev
 * flakes catch prod regressions.
 *
 * The test transport hook `__setTestTransport` lets unit tests observe the
 * outgoing payload without a live SMTP server. Do not call this from
 * application code.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { Tenant } from "@/server/tenant";
import type { Locale } from "@/i18n/routing";

export type EmailTemplate = "verify-email" | "magic-link";

interface TenantEmailInput {
  tenant: Tenant;
  to: string;
  locale: Locale;
  template: EmailTemplate;
  params: { token: string; returnTo?: string };
}

interface MinimalTransport {
  sendMail(options: {
    from?: string;
    to?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

let testTransport: MinimalTransport | null = null;
let productionTransport: Transporter | null = null;

function getTransport(): MinimalTransport {
  if (testTransport) return testTransport;
  if (!productionTransport) {
    const host = process.env.SMTP_HOST ?? "localhost";
    const port = Number.parseInt(process.env.SMTP_PORT ?? "51025", 10);
    // Mailpit accepts unauthenticated SMTP in dev. staging/prod will set
    // user/pass via env.
    productionTransport = nodemailer.createTransport({
      host,
      port,
      secure: false,
      ...(process.env.SMTP_USER
        ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } }
        : {}),
    });
  }
  return productionTransport;
}

export function __setTestTransport(t: MinimalTransport | null): void {
  testTransport = t;
  // Drop any cached production transport so switching back to real mode
  // re-initializes cleanly (used by integration tests).
  productionTransport = null;
}

/**
 * Build a fully-qualified URL bound to the tenant's own domain. Pure: no
 * env, no headers. localhost hosts use http; everything else uses https.
 * Exported so Playwright and unit tests can verify link construction
 * without spinning up SMTP.
 */
export function buildTenantUrl(
  tenant: Tenant,
  locale: Locale,
  path: string,
  query: Record<string, string | undefined>,
): string {
  if (!tenant.primaryDomain) throw new Error("tenant.primaryDomain is empty");
  const isLocal = /^localhost(:|$)/i.test(tenant.primaryDomain) || tenant.primaryDomain.startsWith("127.0.0.1");
  const scheme = isLocal ? "http" : "https";
  const base = `${scheme}://${tenant.primaryDomain}`;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`/${locale}${normalizedPath}`, base);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  return url.toString();
}

interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function subjectFor(template: EmailTemplate, locale: Locale, tenant: Tenant): string {
  if (template === "verify-email") {
    return locale === "ar"
      ? `تأكيد البريد الإلكتروني — ${tenant.name.ar}`
      : `Verify your email — ${tenant.name.en}`;
  }
  return locale === "ar"
    ? `رابط الدخول — ${tenant.name.ar}`
    : `Your sign-in link — ${tenant.name.en}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(template: EmailTemplate, locale: Locale, tenant: Tenant, url: string): RenderedEmail {
  const subject = subjectFor(template, locale, tenant);
  const cta =
    template === "verify-email"
      ? locale === "ar"
        ? "تأكيد البريد الإلكتروني"
        : "Verify email"
      : locale === "ar"
        ? "تسجيل الدخول"
        : "Sign in";
  const body =
    template === "verify-email"
      ? locale === "ar"
        ? `أهلاً. يرجى تأكيد بريدك الإلكتروني لتفعيل حسابك في ${tenant.name.ar}.`
        : `Welcome. Please confirm your email to activate your ${tenant.name.en} account.`
      : locale === "ar"
        ? `استخدم الرابط أدناه لتسجيل الدخول إلى ${tenant.name.ar}. الرابط صالح لعشر دقائق وللاستخدام مرة واحدة.`
        : `Use the link below to sign in to ${tenant.name.en}. It expires in ten minutes and works once.`;

  const text = `${body}\n\n${cta}: ${url}\n`;
  const dir = locale === "ar" ? "rtl" : "ltr";
  const html = `<!doctype html><html lang="${locale}" dir="${dir}"><body><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(cta)}</a></p><p><code>${escapeHtml(url)}</code></p></body></html>`;
  return { subject, text, html };
}

/**
 * Construct the click target. Verify-email and magic-link both hit the
 * Better Auth catch-all at `/api/auth/*`, which then redirects to the
 * locale-prefixed landing page via `callbackURL`. We build the API URL
 * ourselves so we control both (i) the link host (tenant.primaryDomain)
 * and (ii) the post-verify destination (tenant + locale).
 */
function emailLinkUrl(
  tenant: Tenant,
  locale: Locale,
  template: EmailTemplate,
  params: { token: string; returnTo?: string },
): string {
  if (!tenant.primaryDomain) throw new Error("tenant.primaryDomain is empty");
  const isLocal = /^localhost(:|$)/i.test(tenant.primaryDomain) || tenant.primaryDomain.startsWith("127.0.0.1");
  const scheme = isLocal ? "http" : "https";
  const base = `${scheme}://${tenant.primaryDomain}`;
  const apiPath =
    template === "verify-email" ? "/api/auth/verify-email" : "/api/auth/magic-link/verify";
  const url = new URL(apiPath, base);
  url.searchParams.set("token", params.token);
  const callback = params.returnTo ?? `/${locale}/account`;
  url.searchParams.set("callbackURL", callback);
  return url.toString();
}

export async function sendTenantEmail(input: TenantEmailInput): Promise<void> {
  const { tenant, to, locale, template, params } = input;
  if (!tenant.senderEmail) throw new Error("tenant.senderEmail is empty");

  const url = emailLinkUrl(tenant, locale, template, params);

  const { subject, text, html } = render(template, locale, tenant, url);

  await getTransport().sendMail({
    from: tenant.senderEmail,
    to,
    subject,
    text,
    html,
  });
}
