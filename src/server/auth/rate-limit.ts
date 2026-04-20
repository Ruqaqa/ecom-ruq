/**
 * Redis sliding-window rate limiter.
 *
 * Algorithm (per bucket):
 *   - ZADD(now, unique-member) — record the hit.
 *   - ZREMRANGEBYSCORE(bucket, 0, now - window) — trim old entries.
 *   - ZCARD(bucket) — count remaining hits in the window.
 *   - EXPIRE(bucket, window + 1) — let Redis reclaim memory for idle keys.
 *   - Decision: if the post-trim count (including the hit we just added) is
 *     greater than `limit`, reject. Otherwise allow.
 *
 * Atomicity: executed as a single MULTI/EXEC pipeline. No race where two
 * concurrent hits both see a stale count; ZADD + ZCARD are ordered inside
 * EXEC. The "remaining" count reported is post-insert so callers see the
 * remaining budget for the NEXT hit.
 *
 * We never delete the member we just added on a rejection — the rejected
 * hit still counts in the window. That's the harsher-of-the-two behavior
 * that matches how sliding windows should handle spam: repeated failures
 * extend the cooldown.
 */
import Redis from "ioredis";

export interface RateLimitInput {
  bucket: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

let injected: Redis | null = null;
let singleton: Redis | null = null;

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

export async function checkRateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  const { bucket, limit, windowSeconds } = input;
  if (limit < 1) throw new Error("limit must be >= 1");
  if (windowSeconds < 1) throw new Error("windowSeconds must be >= 1");

  const redis = getRedis();
  const key = `ratelimit:${bucket}`;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const windowStart = now - windowMs;
  // Unique member so concurrent hits at the same millisecond do not collapse
  // into one ZSET entry.
  const member = `${now}:${Math.random().toString(36).slice(2)}`;

  const pipeline = redis.multi();
  pipeline.zadd(key, now, member);
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zcard(key);
  pipeline.pexpire(key, windowMs + 1000);
  pipeline.zrange(key, 0, 0, "WITHSCORES");
  const result = await pipeline.exec();
  if (!result) {
    // Redis pipeline failed — fail open is tempting but fail closed is
    // correct here (auth endpoints). Throw so the caller returns 503.
    throw new Error("rate limit pipeline returned null");
  }

  const count = Number(result[2]?.[1] ?? 0);
  const oldestWithScore = result[4]?.[1] as string[] | undefined;
  const oldestScore = oldestWithScore && oldestWithScore[1] ? Number(oldestWithScore[1]) : now;
  const resetSeconds = Math.max(1, Math.ceil((oldestScore + windowMs - now) / 1000));
  const remaining = Math.max(0, limit - count);
  const allowed = count <= limit;

  return { allowed, remaining, resetSeconds };
}
