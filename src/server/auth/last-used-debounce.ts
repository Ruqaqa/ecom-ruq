/**
 * `last_used_at` bump debounce — sub-chunk 7.2 Part C, refactored in
 * 7.6.1 Block D.
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
 *   - bumpLastUsedAt receives an already-opened `Tx`; the caller owns
 *     the `withTenant` scope so `app.tenant_id` is set before the
 *     UPDATE fires (otherwise RLS filters the row out under
 *     `app_user`). The `eq(tenantId)` predicate stays as defense-in-
 *     depth on top of RLS. Errors propagate — the caller swallows at
 *     the audit-adapter layer (fail-open; debounce never gates).
 */
import Redis from "ioredis";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/server/db";
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
 * tenant. Must be called inside a `withTenant` scope so `app.tenant_id`
 * is set for RLS. Errors propagate — the caller (audit adapter)
 * swallows them to preserve the fail-open posture.
 */
export async function bumpLastUsedAt(
  tx: Tx,
  tokenId: string,
  tenantId: string,
): Promise<void> {
  await tx
    .update(accessTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(eq(accessTokens.id, tokenId), eq(accessTokens.tenantId, tenantId)),
    );
}
