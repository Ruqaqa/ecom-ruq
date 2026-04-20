/**
 * Redis sliding-window rate limiter for auth endpoints.
 *
 * Contract:
 *   checkRateLimit({ bucket, limit, windowSeconds }): { allowed, remaining, resetSeconds }
 *   - Each call records a hit in a sorted-set keyed on `bucket`, scored by
 *     the Unix millis timestamp. Entries older than `windowSeconds` are
 *     trimmed. If the resulting set size exceeds `limit`, the request is
 *     rejected; otherwise it is allowed and counted.
 *   - Returns `remaining` (how many more attempts in the current window)
 *     and `resetSeconds` (seconds until the oldest entry expires).
 *
 * The unit tests run against the real Redis on port 56379 (the local dev
 * stack is up). We use a fresh random bucket per test to avoid collisions.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { checkRateLimit, __setRedisForTests } from "@/server/auth/rate-limit";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:56379");

__setRedisForTests(redis);

afterAll(async () => {
  __setRedisForTests(null);
  await redis.quit();
});

function bucket(): string {
  return `auth-test:${randomBytes(6).toString("hex")}`;
}

describe("checkRateLimit", () => {
  it("allows up to `limit` hits in the window", async () => {
    const b = bucket();
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit({ bucket: b, limit: 5, windowSeconds: 60 });
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(4 - i);
    }
  });

  it("rejects the (limit+1)th hit in the same window", async () => {
    const b = bucket();
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit({ bucket: b, limit: 3, windowSeconds: 60 });
      expect(r.allowed).toBe(true);
    }
    const r = await checkRateLimit({ bucket: b, limit: 3, windowSeconds: 60 });
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.resetSeconds).toBeGreaterThan(0);
  });

  it("tracks buckets independently (scoped by key)", async () => {
    const a = bucket();
    const c = bucket();
    await checkRateLimit({ bucket: a, limit: 1, windowSeconds: 60 });
    const aBlocked = await checkRateLimit({ bucket: a, limit: 1, windowSeconds: 60 });
    const cAllowed = await checkRateLimit({ bucket: c, limit: 1, windowSeconds: 60 });
    expect(aBlocked.allowed).toBe(false);
    expect(cAllowed.allowed).toBe(true);
  });

  it("allows again after the window elapses", async () => {
    const b = bucket();
    const r1 = await checkRateLimit({ bucket: b, limit: 1, windowSeconds: 1 });
    expect(r1.allowed).toBe(true);
    const r2 = await checkRateLimit({ bucket: b, limit: 1, windowSeconds: 1 });
    expect(r2.allowed).toBe(false);

    await new Promise((res) => setTimeout(res, 1100));

    const r3 = await checkRateLimit({ bucket: b, limit: 1, windowSeconds: 1 });
    expect(r3.allowed).toBe(true);
  });
});
