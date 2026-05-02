/**
 * Chunk 1a.7.1 Block 2 — BunnyCDN StorageAdapter (mocked fetch).
 *
 * No live integration test (no Bunny in dev). Asserts:
 *   - AccessKey header is set from the configured password
 *   - 200/201 → resolves; 404 (on get) → null
 *   - non-2xx → throws StorageBackendError with opaque code; underlying
 *     vendor error body never appears in error.message
 *   - the password is NOT included in any thrown error message
 *   - URL shape: https://<region>.storage.bunnycdn.com/<zone>/<key>
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { BunnyCdnStorageAdapter } from "@/server/storage/bunnycdn";
import { StorageBackendError } from "@/server/storage/types";

describe("BunnyCdnStorageAdapter", () => {
  const cfg = {
    zone: "ecom-ruq-img",
    region: "ny",
    password: "SECRET-pw-xyz",
  };
  let adapter: BunnyCdnStorageAdapter;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = new BunnyCdnStorageAdapter(cfg);
    // Provide a default that each test overrides.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("put PUTs to the right URL with the AccessKey header set", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 201 }));
    await adapter.put("t-abc/p-0-v1-original.jpg", Buffer.from("x"), "image/jpeg");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://ny.storage.bunnycdn.com/ecom-ruq-img/t-abc/p-0-v1-original.jpg",
    );
    const headers = new Headers((init as RequestInit).headers ?? {});
    expect(headers.get("AccessKey")).toBe("SECRET-pw-xyz");
    expect((init as RequestInit).method).toBe("PUT");
  });

  it("get returns null on 404", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const out = await adapter.get("t-abc/missing.jpg");
    expect(out).toBeNull();
  });

  it("get returns bytes + content type on 200", async () => {
    const body = Buffer.from([1, 2, 3, 4]);
    fetchSpy.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    const out = await adapter.get("t-abc/p-0-v1-original.jpg");
    expect(out).not.toBeNull();
    expect(out!.contentType).toBe("image/jpeg");
    expect(Buffer.compare(out!.bytes, body)).toBe(0);
  });

  it("delete on 200 resolves; on 404 also resolves (idempotent)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(adapter.delete("t-abc/p-0-v1-original.jpg")).resolves.toBeUndefined();
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(adapter.delete("t-abc/missing.jpg")).resolves.toBeUndefined();
  });

  it("non-2xx PUT throws StorageBackendError(upload_failed); message NEVER contains the password", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("internal: AccessKey=SECRET-pw-xyz invalid", { status: 500 }),
    );
    let caught: StorageBackendError | null = null;
    try {
      await adapter.put("t-abc/p-0-v1-original.jpg", Buffer.from("x"), "image/jpeg");
    } catch (e) {
      caught = e as StorageBackendError;
    }
    expect(caught).toBeInstanceOf(StorageBackendError);
    expect(caught!.opaqueCode).toBe("upload_failed");
    // Wire-shape assertion: neither the message nor the toString form
    // ever contains the password.
    expect(caught!.message).not.toContain(cfg.password);
    expect(String(caught)).not.toContain(cfg.password);
  });

  it("non-2xx GET (not 404) throws StorageBackendError(fetch_failed)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    let caught: StorageBackendError | null = null;
    try {
      await adapter.get("t-abc/p-0-v1-original.jpg");
    } catch (e) {
      caught = e as StorageBackendError;
    }
    expect(caught).toBeInstanceOf(StorageBackendError);
    expect(caught!.opaqueCode).toBe("fetch_failed");
    expect(caught!.message).not.toContain(cfg.password);
  });

  it("non-2xx DELETE (not 404) throws StorageBackendError(delete_failed)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    let caught: StorageBackendError | null = null;
    try {
      await adapter.delete("t-abc/p-0-v1-original.jpg");
    } catch (e) {
      caught = e as StorageBackendError;
    }
    expect(caught).toBeInstanceOf(StorageBackendError);
    expect(caught!.opaqueCode).toBe("delete_failed");
    expect(caught!.message).not.toContain(cfg.password);
  });

  it("network failure on put throws StorageBackendError(upload_failed); password not in error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error(`ECONNREFUSED key=${cfg.password}`));
    let caught: StorageBackendError | null = null;
    try {
      await adapter.put("t-abc/p-0-v1-original.jpg", Buffer.from("x"), "image/jpeg");
    } catch (e) {
      caught = e as StorageBackendError;
    }
    expect(caught).toBeInstanceOf(StorageBackendError);
    expect(caught!.opaqueCode).toBe("upload_failed");
    expect(caught!.message).not.toContain(cfg.password);
  });

  it.each(["../escape", "/leading", "double//slash"])(
    "rejects unsafe key %j BEFORE issuing a request",
    async (key) => {
      let caught: unknown = null;
      try {
        await adapter.put(key, Buffer.from("x"), "image/jpeg");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(StorageBackendError);
      // No request should have been issued — the validator caught it.
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
