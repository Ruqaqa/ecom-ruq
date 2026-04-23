/**
 * Chunk 9 — `getTenant()` unknown-host throw shape.
 *
 * `getTenant()` is the RSC-side helper that reads the `Host` header via
 * `next/headers` and looks up the tenant. When no tenant matches, it
 * throws. The thrown message must NOT embed the raw host string (which
 * identifies a tenant); the host belongs in `err.cause` for local
 * developer inspection only.
 *
 * We mock `next/headers` because `getTenant()` depends on a Next.js
 * request scope that the unit suite does not provide.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const mockHeadersGet = vi.fn<(name: string) => string | null>();
vi.mock("next/headers", () => ({
  headers: async () => ({ get: mockHeadersGet }),
}));

afterEach(async () => {
  const { clearTenantCacheForTests, __setTenantLookupLoaderForTests } = await import(
    "@/server/tenant"
  );
  clearTenantCacheForTests();
  __setTenantLookupLoaderForTests(null);
  mockHeadersGet.mockReset();
});

describe("getTenant() — unknown-host throw does not leak the host (chunk 9)", () => {
  it("throws with message 'unknown host' and cause.host = actual host", async () => {
    const { getTenant, __setTenantLookupLoaderForTests } = await import("@/server/tenant");
    __setTenantLookupLoaderForTests(async () => null);
    mockHeadersGet.mockImplementation((name: string) =>
      name.toLowerCase() === "host" ? "spoofed.evil.example.com" : null,
    );

    let thrown: unknown = null;
    try {
      await getTenant();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    // The host string MUST NOT appear in the message — it would hit stdout
    // / Sentry on any unhandled error boundary render.
    expect(err.message).toBe("unknown host");
    expect(err.message).not.toContain("spoofed.evil.example.com");
    // Developer diagnostic preserved via `cause`.
    expect(err.cause).toEqual({ host: "spoofed.evil.example.com" });
  });

  it("throws with cause.host = null when the Host header is missing", async () => {
    const { getTenant, __setTenantLookupLoaderForTests } = await import("@/server/tenant");
    __setTenantLookupLoaderForTests(async () => null);
    mockHeadersGet.mockReturnValue(null);

    let thrown: unknown = null;
    try {
      await getTenant();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).toBe("unknown host");
    expect(err.cause).toEqual({ host: null });
  });
});
