/**
 * Tenant resolution — stub until chunk 5 replaces it with a DB-backed lookup
 * via `tenantLookupDb` (role: `app_tenant_lookup`, narrow column grant on
 * `tenants`). The production resolver MUST:
 *
 *   - in-process cache keyed by normalized (lowercased, port-stripped) host,
 *     TTL ≤ 60s. Node `Map`, not shared Redis.
 *   - return null for unknown hosts (the middleware turns this into a 404
 *     and getTenant throws).
 *   - read only `id, slug, primary_domain, default_locale, status` — the
 *     columns granted to `app_tenant_lookup` in migrations/0001.
 *   - filter on `status = 'active'` (policy already enforces it; belt and braces).
 *
 * Unknown-host behavior is fail-closed by default in both production and
 * development: a resolver that silently substitutes "some tenant" for an
 * unknown domain is the exact shape of a cross-tenant bug. The dev affordance
 * (fall back to the local tenant) is opt-in via ALLOW_TENANT_FALLBACK=1 and
 * is only honored outside production — it cannot accidentally propagate.
 */
import { headers } from "next/headers";
import type { Locale } from "@/i18n/routing";

export interface Tenant {
  id: string;
  domain: string;
  defaultLocale: Locale;
  name: { en: string; ar: string };
}

const STUB_TENANTS: Record<string, Tenant> = {
  "ecom.ruqaqa.sa": {
    id: "ruqaqa",
    domain: "ecom.ruqaqa.sa",
    defaultLocale: "ar",
    name: { en: "Ruqaqa", ar: "رقاقة" },
  },
  "localhost:5001": {
    id: "ruqaqa-local",
    domain: "localhost:5001",
    defaultLocale: "ar",
    name: { en: "Ruqaqa (local)", ar: "رقاقة (محلي)" },
  },
};

const FALLBACK_TENANT: Tenant = {
  id: "ruqaqa-local",
  domain: "localhost:5001",
  defaultLocale: "ar",
  name: { en: "Ruqaqa (local)", ar: "رقاقة (محلي)" },
};

function fallbackAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.ALLOW_TENANT_FALLBACK === "1";
}

export function resolveTenant(host: string | null | undefined): Tenant | null {
  const normalized = host?.toLowerCase() ?? null;
  if (normalized && STUB_TENANTS[normalized]) return STUB_TENANTS[normalized];
  if (fallbackAllowed()) return FALLBACK_TENANT;
  return null;
}

export async function getTenant(): Promise<Tenant> {
  const h = await headers();
  const host = h.get("host");
  const tenant = resolveTenant(host);
  if (!tenant) throw new Error(`unknown host: ${host ?? "<missing>"}`);
  return tenant;
}
