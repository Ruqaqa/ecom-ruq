/**
 * Tenant resolution.
 *
 * Contract:
 *   - resolveTenant(host) is async, normalizes (lowercase), and returns the
 *     full Tenant or null.
 *   - Hits are cached in-process, TTL 60s. Negative hits are cached too, so
 *     a flood of traffic to an unknown host does not hammer the resolver
 *     pool. invalidateTenantCache(host) drops a specific entry.
 *   - The resolver consults ONLY `app_tenant_lookup` (narrow column grant
 *     on `tenants`). It never reads via `app_user` — that pool is for
 *     tenant-scoped work, which requires the tenant context to already be
 *     resolved.
 *   - Unknown hosts return null. In development only, `ALLOW_TENANT_FALLBACK=1`
 *     substitutes a synthetic localhost tenant. The flag is hard-ignored in
 *     production regardless of value.
 *
 * The resolver is called:
 *   - From the Next.js middleware BEFORE i18n routing runs, so we know which
 *     tenant's default locale to bias toward.
 *   - From RSC via `getTenant()` during rendering (reads `headers()`).
 *   - From the Better Auth sendVerificationEmail / sendMagicLink hooks, which
 *     pass `tenant` into `sendTenantEmail` directly rather than re-deriving
 *     from the request — see src/server/email/send-tenant-email.ts for the
 *     boundary.
 */
import { headers } from "next/headers";
import { eq, and } from "drizzle-orm";
import { tenantLookupDb } from "@/server/db";
import { tenants } from "@/server/db/schema/tenants";
import type { Locale } from "@/i18n/routing";
import type { LocalizedText } from "@/lib/i18n/localized";

export interface Tenant {
  id: string;
  slug: string;
  primaryDomain: string;
  defaultLocale: Locale;
  senderEmail: string;
  name: LocalizedText;
}

type Loader = (host: string) => Promise<Tenant | null>;

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: Tenant | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

let loaderOverride: Loader | null = null;

function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  return host.toLowerCase();
}

function fallbackAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.ALLOW_TENANT_FALLBACK === "1";
}

function syntheticFallback(host: string): Tenant {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    slug: "ruqaqa-local",
    primaryDomain: host,
    defaultLocale: "ar",
    senderEmail: "no-reply@localhost",
    name: { en: "Ruqaqa (local)", ar: "رقاقة (محلي)" },
  };
}

async function defaultLoader(host: string): Promise<Tenant | null> {
  if (!tenantLookupDb) return null;
  const rows = await tenantLookupDb
    .select({
      id: tenants.id,
      slug: tenants.slug,
      primaryDomain: tenants.primaryDomain,
      defaultLocale: tenants.defaultLocale,
      senderEmail: tenants.senderEmail,
      name: tenants.name,
      status: tenants.status,
    })
    .from(tenants)
    .where(and(eq(tenants.primaryDomain, host), eq(tenants.status, "active")))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    primaryDomain: row.primaryDomain,
    defaultLocale: row.defaultLocale as Locale,
    senderEmail: row.senderEmail,
    name: row.name,
  };
}

export async function resolveTenant(host: string | null | undefined): Promise<Tenant | null> {
  const normalized = normalizeHost(host);
  if (normalized === null) return null;

  const now = Date.now();
  const hit = cache.get(normalized);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  const loader = loaderOverride ?? defaultLoader;
  let value = await loader(normalized);

  if (value === null && fallbackAllowed()) {
    value = syntheticFallback(normalized);
  }

  cache.set(normalized, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/**
 * Drop a specific host's cache entry. Called by the tenant-update service
 * when a tenant's domain or status changes. Idempotent — no-op if the key
 * is missing.
 */
export function invalidateTenantCache(host: string | null | undefined): void {
  const normalized = normalizeHost(host);
  if (normalized === null) return;
  cache.delete(normalized);
}

/**
 * Test-only hook. Clears the entire cache. Do not call from application code.
 */
export function clearTenantCacheForTests(): void {
  cache.clear();
}

/**
 * Test-only hook. Injects a fake loader. Pass null to restore the default.
 * Unit tests use this so they don't need a live app_tenant_lookup pool.
 */
export function __setTenantLookupLoaderForTests(loader: Loader | null): void {
  loaderOverride = loader;
}

export async function getTenant(): Promise<Tenant> {
  const h = await headers();
  const host = h.get("host");
  const tenant = await resolveTenant(host);
  if (!tenant) throw new Error(`unknown host: ${host ?? "<missing>"}`);
  return tenant;
}
