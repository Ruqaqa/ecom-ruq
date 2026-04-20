/**
 * DB-backed tenant resolver tests.
 *
 * The resolver is the only code path that consumes `app_tenant_lookup`.
 * It MUST:
 *   - normalize the host (lowercase, no port stripping: compose dev runs on
 *     `localhost:5001`, which IS the primaryDomain in dev).
 *   - cache hits in-process with a TTL ≤60s, invalidatable via
 *     `invalidateTenantCache(host)`.
 *   - return null for unknown hosts (fail-closed). Dev fallback via
 *     ALLOW_TENANT_FALLBACK=1 stays opt-in and is ignored in production.
 *   - never touch `app_user` scoped tables. Reading from `app_tenant_lookup`
 *     is narrow-column and carries its own policy (`tenant_resolver_read`).
 *
 * The tests below inject a fake DB via `__setTenantLookupDbForTests` so the
 * unit suite does not have to spin up the real app_tenant_lookup pool.
 * The RLS canary in tests/unit/db/ continues to cover the policy surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  resolveTenant,
  invalidateTenantCache,
  clearTenantCacheForTests,
  __setTenantLookupLoaderForTests,
  type Tenant,
} from "@/server/tenant";

const env = process.env as Record<string, string | undefined>;

function tenantFor(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: randomUUID(),
    slug: "ruqaqa",
    primaryDomain: "localhost:5001",
    defaultLocale: "ar",
    senderEmail: "no-reply@localhost",
    name: { en: "Ruqaqa", ar: "رقاقة" },
    ...overrides,
  };
}

afterEach(() => {
  clearTenantCacheForTests();
  __setTenantLookupLoaderForTests(null);
  delete env.ALLOW_TENANT_FALLBACK;
});

describe("resolveTenant — DB-backed", () => {
  it("returns null for null/undefined host", async () => {
    const loader = vi.fn();
    __setTenantLookupLoaderForTests(loader);
    expect(await resolveTenant(null)).toBeNull();
    expect(await resolveTenant(undefined)).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it("normalizes the host before lookup (case-insensitive)", async () => {
    const tenant = tenantFor({ primaryDomain: "brand-a.com" });
    const loader = vi.fn().mockResolvedValue(tenant);
    __setTenantLookupLoaderForTests(loader);

    const got = await resolveTenant("BRAND-A.com");
    expect(got?.id).toBe(tenant.id);
    expect(loader).toHaveBeenCalledWith("brand-a.com");
  });

  it("caches hits and does not re-hit the loader within the TTL", async () => {
    const tenant = tenantFor({ primaryDomain: "brand-a.com" });
    const loader = vi.fn().mockResolvedValue(tenant);
    __setTenantLookupLoaderForTests(loader);

    await resolveTenant("brand-a.com");
    await resolveTenant("brand-a.com");
    await resolveTenant("brand-a.com");

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("caches negative hits too (unknown hosts stay fail-closed without re-querying)", async () => {
    const loader = vi.fn().mockResolvedValue(null);
    __setTenantLookupLoaderForTests(loader);

    expect(await resolveTenant("unknown.example.com")).toBeNull();
    expect(await resolveTenant("unknown.example.com")).toBeNull();

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("invalidateTenantCache(host) forces a reload on the next call", async () => {
    const first = tenantFor({ primaryDomain: "brand-a.com", slug: "first" });
    const second = tenantFor({ primaryDomain: "brand-a.com", slug: "second" });
    const loader = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    __setTenantLookupLoaderForTests(loader);

    const a = await resolveTenant("brand-a.com");
    expect(a?.slug).toBe("first");

    invalidateTenantCache("BRAND-A.COM");
    const b = await resolveTenant("brand-a.com");
    expect(b?.slug).toBe("second");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("ignores ALLOW_TENANT_FALLBACK in production", async () => {
    const loader = vi.fn().mockResolvedValue(null);
    __setTenantLookupLoaderForTests(loader);
    env.NODE_ENV = "production";
    env.ALLOW_TENANT_FALLBACK = "1";
    try {
      expect(await resolveTenant("unknown.example.com")).toBeNull();
    } finally {
      env.NODE_ENV = "test";
      delete env.ALLOW_TENANT_FALLBACK;
    }
  });

  it("returns a synthetic fallback tenant in dev when ALLOW_TENANT_FALLBACK=1", async () => {
    const loader = vi.fn().mockResolvedValue(null);
    __setTenantLookupLoaderForTests(loader);
    env.NODE_ENV = "development";
    env.ALLOW_TENANT_FALLBACK = "1";
    try {
      const got = await resolveTenant("unknown.example.com");
      expect(got).not.toBeNull();
      expect(got?.primaryDomain).toBeTruthy();
      expect(got?.senderEmail).toMatch(/^[^@]+@[^@]+$/);
    } finally {
      env.NODE_ENV = "test";
      delete env.ALLOW_TENANT_FALLBACK;
    }
  });

  it("expires cache entries after the TTL", async () => {
    const first = tenantFor({ primaryDomain: "brand-a.com", slug: "first" });
    const second = tenantFor({ primaryDomain: "brand-a.com", slug: "second" });
    const loader = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    __setTenantLookupLoaderForTests(loader);

    vi.useFakeTimers();
    try {
      const a = await resolveTenant("brand-a.com");
      expect(a?.slug).toBe("first");

      // Advance past the 60s TTL boundary.
      vi.advanceTimersByTime(61_000);

      const b = await resolveTenant("brand-a.com");
      expect(b?.slug).toBe("second");
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveTenant — ALLOW_TENANT_FALLBACK reset between tests", () => {
  beforeEach(() => {
    // belt and braces so test ordering can't leak fallback
    delete env.ALLOW_TENANT_FALLBACK;
  });

  it("defaults to fail-closed in a pristine env", async () => {
    const loader = vi.fn().mockResolvedValue(null);
    __setTenantLookupLoaderForTests(loader);
    expect(await resolveTenant("unknown.example.com")).toBeNull();
  });
});
