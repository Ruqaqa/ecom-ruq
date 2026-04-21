/**
 * `last_used_at` bump debounce — sub-chunk 7.2 Part C.
 *
 * `access_tokens.last_used_at` powers the "is this PAT in active use?"
 * UI signal. Naively writing it on every MCP / tRPC call would cost one
 * UPDATE + WAL write per dispatch — wasteful, and more importantly, it
 * would create row-lock contention on a hot token. We debounce via a
 * Redis SET NX EX with a 60s key: the first call in any 60s window
 * writes, the rest skip.
 *
 * Security posture:
 *   - shouldWriteLastUsedAt is NOT a security gate. Failures (Redis
 *     down, transient timeout) return false — the bump is skipped,
 *     the request still proceeds. Security comes from the token lookup,
 *     not from the bump.
 *   - bumpLastUsedAt: tenant-scoped UPDATE with an `eq(tenantId)`
 *     predicate (defense-in-depth on top of RLS). Errors captured via
 *     Sentry shim but swallowed — same fail-open posture.
 */
import Redis from "ioredis";
import { and, eq, sql } from "drizzle-orm";
import { appDb } from "@/server/db";
import { accessTokens } from "@/server/db/schema/tokens";

const DEBOUNCE_WINDOW_SECONDS = 60;

let injected: Redis | null = null;
let singleton: Redis | null = null;

/** Test-only seam. Pass null to restore the default. */
export function __setRedisForTests(client: Redis | null): void {
  injected = client;
}

function getRedis(): Redis {
  if (injected) return injected;
  if (!singleton) {
    singleton = new Redis(process.env.REDIS_URL ?? "redis://localhost:56379", {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
  }
  return singleton;
}

/**
 * Returns true if we should write last_used_at for this tokenId within
 * the current 60s window. Uses `SET NX EX` — the first caller in the
 * window wins. On Redis outage returns false (fail-open; debounce is
 * not a gate).
 */
export async function shouldWriteLastUsedAt(tokenId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const key = `debounce:lastUsed:${tokenId}`;
    const res = await redis.set(key, "1", "EX", DEBOUNCE_WINDOW_SECONDS, "NX");
    return res === "OK";
  } catch {
    return false;
  }
}

/**
 * Update `last_used_at = now()` for the given token, scoped to the
 * tenant. The `eq(tenantId)` predicate is redundant under RLS but
 * belt-and-braces in case a future code path bypasses the GUC-backed
 * `app_user` pool. Errors are captured via the Sentry shim and
 * swallowed — this is best-effort.
 */
export async function bumpLastUsedAt(
  tokenId: string,
  tenantId: string,
): Promise<void> {
  if (!appDb) return;
  try {
    await appDb
      .update(accessTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(eq(accessTokens.id, tokenId), eq(accessTokens.tenantId, tenantId)),
      );
  } catch (err) {
    const { captureMessage } = await import("@/server/obs/sentry");
    captureMessage("last_used_bump_failure", {
      level: "warning",
      tags: {
        tenant_id: tenantId,
        token_id: tokenId,
      },
      extra: { cause: String(err) },
    });
  }
}
