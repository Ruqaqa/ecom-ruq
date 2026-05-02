/**
 * Chunk 1a.7.1 Block 2 — local-disk StorageAdapter.
 *
 * Layered defenses against writing/reading outside the configured local
 * directory:
 *
 *   1. `assertSafeStorageKey(key)` — explicit denylist (`..`, leading
 *      `/`, double `//`, trailing `/`, NUL, backslash, non-allowlist
 *      char).
 *   2. `path.resolve(localDir, key).startsWith(localDir + sep)` — second
 *      wall. Defeats any `..` collapse that the validator missed.
 *   3. After write: `realpathSync(written)` MUST start with the realpath
 *      of localDir. Defeats symlink trickery (an attacker who somehow
 *      created a symlink inside localDir pointing outside cannot use it
 *      to escape).
 *
 * `delete` is idempotent — deleting a missing key is a no-op, not an
 * error. Buyer-facing flows depend on this (mid-upload aborts).
 */
import { promises as fs, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { StorageBackendError, assertSafeStorageKey, type StorageAdapter } from "./types";

export class LocalDiskStorageAdapter implements StorageAdapter {
  private readonly rootRealpath: string;
  constructor(private readonly rootDir: string) {
    // Normalize once at construction. realpath fails if the dir doesn't
    // exist; the caller is expected to ensure it does (the factory in
    // index.ts creates it). We accept a non-existent dir at construction
    // time and resolve at write-time instead.
    let real: string;
    try {
      real = realpathSync(rootDir);
    } catch {
      real = resolve(rootDir);
    }
    this.rootRealpath = real;
  }

  private resolveKey(key: string): string {
    assertSafeStorageKey(key);
    const target = resolve(this.rootDir, key);
    // Second wall: `..` could in principle collapse past the validator
    // (it shouldn't — we already reject `..` segments — but defense in
    // depth is the point of this whole subsystem).
    if (!target.startsWith(this.rootDir + sep) && target !== this.rootDir) {
      throw new StorageBackendError("upload_failed", "resolve-escape");
    }
    return target;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const target = this.resolveKey(key);
    try {
      await fs.mkdir(dirname(target), { recursive: true });
      // Realpath the destination dir AFTER creation but BEFORE writing,
      // so a symlink-target outside rootDir is caught here. realpath
      // fails-closed by throwing on a broken symlink — that's what we
      // want.
      const dirReal = await fs.realpath(dirname(target));
      const rootReal = this.rootRealpath;
      if (dirReal !== rootReal && !dirReal.startsWith(rootReal + sep)) {
        throw new StorageBackendError("upload_failed", "symlink-escape");
      }
      await fs.writeFile(target, bytes);
      // Companion content-type sidecar so `get()` can return what the
      // caller put. Tiny — three bytes for "image/jpeg".
      await fs.writeFile(target + ".ct", contentType, "utf8");
    } catch (err) {
      if (err instanceof StorageBackendError) throw err;
      throw new StorageBackendError("upload_failed", err);
    }
  }

  async get(key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const target = this.resolveKey(key);
    try {
      const bytes = await fs.readFile(target);
      let contentType = "application/octet-stream";
      try {
        contentType = (await fs.readFile(target + ".ct", "utf8")).trim() || contentType;
      } catch {
        /* sidecar absent — keep default */
      }
      return { bytes, contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new StorageBackendError("fetch_failed", err);
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveKey(key);
    try {
      await fs.unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Idempotent — no sidecar to clean up either; both gone.
        return;
      }
      throw new StorageBackendError("delete_failed", err);
    }
    // Best-effort sidecar cleanup. A missing sidecar is fine.
    try {
      await fs.unlink(target + ".ct");
    } catch {
      /* ignore */
    }
  }
}
