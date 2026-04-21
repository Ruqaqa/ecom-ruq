/**
 * Admin layout — server-side guard.
 *
 * Every route under `/{locale}/admin/*` is owner/staff-only. We enforce
 * that server-side here so an anonymous or customer-role request never
 * renders admin markup. The client-side form additionally handles
 * mutation-throw paths (Zod validation, network error); the layout
 * redirect covers the access-control path.
 *
 * `force-dynamic` disables SSG for every route under this layout.
 * Admin pages depend on a live session and a DB round-trip for
 * membership — both unavailable during `next build`'s SSG pass.
 * Without this, the build's static-generation phase runs this guard
 * with no real Request + no tenant, which produces bogus redirects or
 * crashes and poisons the final manifest write. Landing on the
 * layout applies to every current and future `/admin/*` route.
 */
export const dynamic = "force-dynamic";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveTenant } from "@/server/tenant";
import { resolveRequestIdentity } from "@/server/auth/resolve-request-identity";
import { resolveMembership } from "@/server/auth/membership";

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const h = await headers();
  const host = h.get("host");
  const tenant = await resolveTenant(host);
  if (!tenant) redirect(`/${locale}`);

  const identity = await resolveRequestIdentity(h, tenant);
  if (identity.type === "anonymous") {
    redirect(`/${locale}/signin`);
  }
  const membership = await resolveMembership(identity.userId, tenant.id);
  if (!membership || !["owner", "staff"].includes(membership.role)) {
    redirect(`/${locale}/signin?denied=admin`);
  }

  return <>{children}</>;
}
