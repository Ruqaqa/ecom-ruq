/**
 * Chunk 1a.7.1 Block 2 — storage adapter factory.
 *
 * `IMAGE_STORAGE_BACKEND` selects the backend:
 *   - unset / "local"  → LocalDiskStorageAdapter under
 *                        `IMAGE_STORAGE_LOCAL_DIR` (default `.storage/images`)
 *   - "bunny"          → BunnyCdnStorageAdapter; requires
 *                        BUNNY_STORAGE_{ZONE,REGION,PASSWORD}
 *
 * The factory is called from service code, NOT at module import time.
 * Lazy resolution lets tests flip env vars without re-importing.
 *
 * The factory is dumb byte-pushing infrastructure (security IN-4): it
 * never reads request context, never knows about tenants, never enforces
 * authorization. Those live in the service layer above.
 */
import { resolve } from "node:path";
import { LocalDiskStorageAdapter } from "./local-disk";
import { BunnyCdnStorageAdapter } from "./bunnycdn";
import type { StorageAdapter } from "./types";

export type { StorageAdapter } from "./types";
export { StorageBackendError, assertSafeStorageKey } from "./types";
export { LocalDiskStorageAdapter } from "./local-disk";
export { BunnyCdnStorageAdapter } from "./bunnycdn";

const DEFAULT_LOCAL_DIR = ".storage/images";

let testOverride: StorageAdapter | null = null;

/**
 * Test seam — replace the factory's return value with an in-memory or
 * spy adapter. Production code paths (services, route handlers) call
 * `getStorageAdapter()` without arguments; the seam lets tests inject
 * a fake without monkey-patching env vars or stubbing fs.
 *
 * Pass `null` to clear the override. Always called in `afterAll`.
 */
export function __setStorageAdapterForTests(
  adapter: StorageAdapter | null,
): void {
  testOverride = adapter;
}

export function getStorageAdapter(): StorageAdapter {
  if (testOverride) return testOverride;
  const backend = (process.env.IMAGE_STORAGE_BACKEND ?? "local").toLowerCase();
  if (backend === "local") {
    const dir = process.env.IMAGE_STORAGE_LOCAL_DIR ?? DEFAULT_LOCAL_DIR;
    return new LocalDiskStorageAdapter(resolve(process.cwd(), dir));
  }
  if (backend === "bunny") {
    const zone = process.env.BUNNY_STORAGE_ZONE;
    const region = process.env.BUNNY_STORAGE_REGION;
    const password = process.env.BUNNY_STORAGE_PASSWORD;
    if (!zone || !region || !password) {
      throw new Error(
        "Refusing to start: bunny storage selected but BUNNY_STORAGE_{ZONE,REGION,PASSWORD} is not fully configured.",
      );
    }
    return new BunnyCdnStorageAdapter({ zone, region, password });
  }
  throw new Error(
    `Refusing to start: IMAGE_STORAGE_BACKEND must be "local" or "bunny" (got: ${backend}).`,
  );
}
