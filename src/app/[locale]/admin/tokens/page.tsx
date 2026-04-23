/**
 * Admin PAT-management entry (sub-chunk 7.5).
 *
 * RSC shell: sets the locale for next-intl, resolves the viewer's
 * membership role (owner vs staff) via the shared auth stack, then hands
 * off to a client component that owns the list query + reveal state +
 * revoke dialog state. The admin layout's guard already rejects anonymous
 * and customer callers; by the time this component runs, we're at least
 * a staff or owner member.
 *
 * Role is passed as a prop so the client can hide the create/revoke
 * controls for staff. The RSC->client trust boundary is: the client
 * can never widen its own role (no server actions here, see
 * tokens-client.tsx header note). Tampering with the prop buys nothing
 * because all tokens.* procedures enforce the gate server-side via
 * `requireRole({ roles: ['owner'], identity: 'session' })` (7.6.2):
 * owner-only AND session-only, so bearer tokens cannot self-administer
 * other bearer tokens.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing, type Locale } from "@/i18n/routing";
import { resolveTenant } from "@/server/tenant";
import { resolveRequestIdentity } from "@/server/auth/resolve-request-identity";
import { resolveMembership } from "@/server/auth/membership";
import { TokensClient, type ViewerRole } from "./tokens-client";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.tokens" });
  return { title: t("title") };
}

export default async function AdminTokensPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("admin.tokens");

  // The admin layout already gated anonymous/customer. Resolve here again
  // only to pick up the membership role — the layout check redirects
  // before we render, so this runs under a known-authed request.
  const h = await headers();
  const host = h.get("host");
  const tenant = await resolveTenant(host);
  if (!tenant) redirect(`/${locale}`);
  const identity = await resolveRequestIdentity(h, tenant);
  if (identity.type === "anonymous") redirect(`/${locale}/signin`);
  const membership = await resolveMembership(identity.userId, tenant.id);
  const role: ViewerRole = membership?.role === "owner" ? "owner" : "staff";

  return (
    <main className="flex min-h-screen items-start justify-center p-6 pt-12">
      <div className="w-full max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{t("subtitle")}</p>
        <div className="mt-6">
          <TokensClient locale={locale as Locale} viewerRole={role} />
        </div>
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
