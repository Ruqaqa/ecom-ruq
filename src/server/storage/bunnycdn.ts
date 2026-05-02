/**
 * Chunk 1a.7.1 Block 2 — BunnyCDN Storage Zone StorageAdapter.
 *
 * Endpoint: `https://<region>.storage.bunnycdn.com/<zone>/<key>`.
 * Auth: `AccessKey: <password>` header. NEVER logged, NEVER echoed.
 *
 * Wire shape: every error throws StorageBackendError(opaque-code) with
 * the underlying cause attached for Sentry capture only. The error
 * message is the opaque code; the password is never on the wire.
 */
import { StorageBackendError, assertSafeStorageKey, type StorageAdapter } from "./types";

export interface BunnyCdnConfig {
  zone: string;
  region: string;
  password: string;
}

export class BunnyCdnStorageAdapter implements StorageAdapter {
  private readonly base: string;
  constructor(private readonly cfg: BunnyCdnConfig) {
    this.base = `https://${cfg.region}.storage.bunnycdn.com/${cfg.zone}`;
  }

  private url(key: string): string {
    return `${this.base}/${key}`;
  }

  private headers(extra?: HeadersInit): Headers {
    const h = new Headers(extra);
    h.set("AccessKey", this.cfg.password);
    return h;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    assertSafeStorageKey(key);
    let res: Response;
    try {
      res = await fetch(this.url(key), {
        method: "PUT",
        headers: this.headers({ "content-type": contentType }),
        // Buffer is a valid BodyInit at runtime (Node's undici accepts
        // it); the lib.dom BodyInit type uses a branded Uint8Array that
        // the resolver flags. Cast at this single boundary.
        body: bytes as unknown as BodyInit,
      });
    } catch (err) {
      // Network failure. Underlying error may carry the password if a
      // misconfigured DNS entry echoes it back; never on the wire.
      throw new StorageBackendError("upload_failed", err);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new StorageBackendError("upload_failed", `bunny:${res.status}`);
    }
  }

  async get(key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    assertSafeStorageKey(key);
    let res: Response;
    try {
      res = await fetch(this.url(key), {
        method: "GET",
        headers: this.headers(),
      });
    } catch (err) {
      throw new StorageBackendError("fetch_failed", err);
    }
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      throw new StorageBackendError("fetch_failed", `bunny:${res.status}`);
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const buf = Buffer.from(await res.arrayBuffer());
    return { bytes: buf, contentType };
  }

  async delete(key: string): Promise<void> {
    assertSafeStorageKey(key);
    let res: Response;
    try {
      res = await fetch(this.url(key), {
        method: "DELETE",
        headers: this.headers(),
      });
    } catch (err) {
      throw new StorageBackendError("delete_failed", err);
    }
    // Idempotent on 404.
    if (res.status === 404) return;
    if (res.status < 200 || res.status >= 300) {
      throw new StorageBackendError("delete_failed", `bunny:${res.status}`);
    }
  }
}
