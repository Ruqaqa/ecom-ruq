/**
 * `last_used_at` debounce — sub-chunk 7.2 Part C tests.
 *
 * Contract:
 *   - SET NX EX pattern: first caller in a 60s window returns true;
 *     subsequent callers inside the window return false.
 *   - Redis outage (SET throws) returns false, never throws.
 *   - bumpLastUsedAt swallows DB errors (captures Sentry-shim message).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  __setRedisForTests,
  shouldWriteLastUsedAt,
} from "@/server/auth/last-used-debounce";

interface FakeRedisOptions {
  onSet: (key: string, value: string, expiry: string, window: number, nx: string) => string | null;
}

// Narrow enough shape that TS accepts it as `Redis`. ioredis's real
// type has huge surface; we inject only `set` here because that's the
// only method under test.
function makeFakeRedis(opts: FakeRedisOptions): import("ioredis").default {
  return {
    set: vi.fn(opts.onSet),
  } as unknown as import("ioredis").default;
}

afterEach(() => {
  __setRedisForTests(null);
});

describe("shouldWriteLastUsedAt", () => {
  it("returns true when SET NX EX reports OK (first caller in window)", async () => {
    __setRedisForTests(
      makeFakeRedis({
        onSet: () => "OK",
      }),
    );
    const ok = await shouldWriteLastUsedAt("tok-1");
    expect(ok).toBe(true);
  });

  it("returns false on subsequent call in same window (NX fails → null)", async () => {
    let called = 0;
    __setRedisForTests(
      makeFakeRedis({
        onSet: () => {
          called += 1;
          return called === 1 ? "OK" : null;
        },
      }),
    );
    expect(await shouldWriteLastUsedAt("tok-2")).toBe(true);
    expect(await shouldWriteLastUsedAt("tok-2")).toBe(false);
  });

  it("returns false on Redis outage (SET throws) — does NOT throw", async () => {
    __setRedisForTests(
      makeFakeRedis({
        onSet: () => {
          throw new Error("redis down");
        },
      }),
    );
    const ok = await shouldWriteLastUsedAt("tok-3");
    expect(ok).toBe(false);
  });

  it("uses key debounce:lastUsed:<tokenId> with 60s EX and NX", async () => {
    const captured: { key?: string; value?: string; expiry?: string; window?: number; nx?: string } = {};
    __setRedisForTests(
      makeFakeRedis({
        onSet: (key, value, expiry, window, nx) => {
          captured.key = key;
          captured.value = value;
          captured.expiry = expiry;
          captured.window = window;
          captured.nx = nx;
          return "OK";
        },
      }),
    );
    await shouldWriteLastUsedAt("tok-4");
    expect(captured.key).toBe("debounce:lastUsed:tok-4");
    expect(captured.value).toBe("1");
    expect(captured.expiry).toBe("EX");
    expect(captured.window).toBe(60);
    expect(captured.nx).toBe("NX");
  });
});
