/**
 * Chunk 9 — observability scrubber.
 *
 * The Sentry shim (`src/server/obs/sentry.ts`) funnels five call sites
 * (audit-wrap failure, audit writer failure, PAT last-used bump failure,
 * BA tenant-resolution-lost hook, BA sign-up failure hook). Every one of
 * them today hands the shim structured extras / tags that embed customer
 * identifiers (tenantId, userId, tokenId, host). The shim's console fallback
 * writes them to stderr; the eventual Sentry DSN wired in Phase 1b would
 * send them to an external service. Neither is acceptable.
 *
 * Design choice locked 2026-04-23: the scrubber DROPS identifier-typed keys
 * rather than replacing them with a redacted sentinel. The audit log is the
 * forensic source of truth; the observability log is debugging metadata and
 * does not need to preserve shape.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  captureMessage,
  scrubObsValue,
  summarizeErrorForObs,
  OBS_IDENTIFIER_KEYS,
  __setSentryForTests,
  type SentryLike,
} from "@/server/obs/sentry";

afterEach(() => {
  __setSentryForTests(null);
});

describe("scrubObsValue — key-based identifier drop", () => {
  it("drops tenant_id (snake_case)", () => {
    expect(scrubObsValue({ tenant_id: "00000000-0000-0000-0000-000000000001", op: "x" })).toEqual({
      op: "x",
    });
  });

  it("drops tenantId (camelCase) — case-insensitive match", () => {
    expect(scrubObsValue({ tenantId: "uuid-here", op: "x" })).toEqual({ op: "x" });
  });

  it("drops every flavor of identifier in OBS_IDENTIFIER_KEYS", () => {
    const input: Record<string, unknown> = {};
    for (const key of OBS_IDENTIFIER_KEYS) {
      input[key] = "sensitive-value";
    }
    input.keep_me = 1;
    const out = scrubObsValue(input) as Record<string, unknown>;
    expect(out).toEqual({ keep_me: 1 });
    for (const key of OBS_IDENTIFIER_KEYS) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it("drops belt-and-braces PII keys (email, plaintext, tokenHash, password, nationalId)", () => {
    const input = {
      email: "customer@example.com",
      plaintext: "eruq_pat_CANARY",
      tokenHash: Buffer.from([1, 2, 3]),
      password: "hunter2",
      nationalId: "1234567890",
      operation: "auth.signup",
    };
    expect(scrubObsValue(input)).toEqual({ operation: "auth.signup" });
  });

  it("is case-insensitive: drops TENANT_ID, Tenant_Id, TenantID", () => {
    expect(
      scrubObsValue({
        TENANT_ID: "a",
        Tenant_Id: "b",
        TenantID: "c",
        operation: "x",
      }),
    ).toEqual({ operation: "x" });
  });

  it("recurses into nested objects", () => {
    const input = {
      outer: {
        inner: { tenant_id: "leak", safe: 1 },
        safe: 2,
      },
      safe: 3,
    };
    expect(scrubObsValue(input)).toEqual({
      outer: {
        inner: { safe: 1 },
        safe: 2,
      },
      safe: 3,
    });
  });

  it("recurses into arrays of objects", () => {
    const input = {
      items: [
        { tenant_id: "a", keep: 1 },
        { user_id: "b", keep: 2 },
      ],
    };
    expect(scrubObsValue(input)).toEqual({
      items: [{ keep: 1 }, { keep: 2 }],
    });
  });

  it("preserves arrays of scalars", () => {
    expect(scrubObsValue({ counts: [1, 2, 3], op: "x" })).toEqual({
      counts: [1, 2, 3],
      op: "x",
    });
  });

  it("neutralizes non-plain objects (URL, Date, Error subclass) to constructor-name sentinels", () => {
    // Bypass 1 + bypass 2 defense: any class instance is replaced with a
    // `[object ClassName]` string. Preserving them would let
    // JSON.stringify invoke their custom toJSON (URL → full URL including
    // Host, Date → ISO string) or walk their enumerable own properties
    // (Error subclasses with `host`, `query`, etc.).
    const url = new URL("https://shop-tenant-a.example.com/path?id=42");
    const date = new Date("2026-04-23T00:00:00Z");
    class DbError extends Error {
      constructor(
        msg: string,
        public host: string,
      ) {
        super(msg);
        this.name = "DbError";
      }
    }
    const err = new DbError("boom", "shop-tenant-b.example.com");

    const out = scrubObsValue({ url, date, err, op: "x" }) as Record<string, unknown>;
    expect(out.url).toBe("[object URL]");
    expect(out.date).toBe("[object Date]");
    expect(out.err).toBe("[object DbError]");
    expect(out.op).toBe("x");
    // The hostnames must not appear anywhere in the serialized output.
    const joined = JSON.stringify(out);
    expect(joined).not.toContain("shop-tenant-a.example.com");
    expect(joined).not.toContain("shop-tenant-b.example.com");
  });

  it("strips own toJSON methods from plain objects (bypass 3 defense)", () => {
    // Bypass 3 defense: a plain object with a custom `toJSON` would have
    // its toJSON invoked by JSON.stringify at the console fallback,
    // emitting whatever string the caller chose — sidestepping key-based
    // scrubbing entirely.
    const leakyTenantId = "00000000-0000-0000-0000-0000000BADBAD";
    const poisoned = {
      safe: 1,
      toJSON() {
        return `tenant=${leakyTenantId}`;
      },
    };
    const out = scrubObsValue({ data: poisoned }) as {
      data: { safe: number; toJSON?: unknown };
    };
    expect(out.data.safe).toBe(1);
    expect(out.data.toJSON).toBeUndefined();
    // And the final serialized form must not pick up the tenant id.
    expect(JSON.stringify(out)).not.toContain(leakyTenantId);
  });

  it("returns a depth-limit sentinel rather than silently passing through at extreme nesting", () => {
    // The 50-deep chain from the earlier test lives in scrub-friendly
    // territory (MAX_SCRUB_DEPTH = 20 is walked; beyond that we return
    // a sentinel). Confirm the sentinel, not the raw value, emerges.
    type Nested = { next?: Nested; tenant_id?: string };
    const root: Nested = {};
    let cursor: Nested = root;
    for (let i = 0; i < 30; i++) {
      cursor.next = { tenant_id: `uuid-${i}` };
      cursor = cursor.next;
    }
    // At depth 20 the walk stops. Serializing the result must not
    // contain any of the tenant UUIDs past the depth limit.
    const out = JSON.stringify(scrubObsValue(root));
    expect(out).not.toContain(`uuid-29`);
    expect(out).toContain("[scrub_depth_limit]");
  });

  it("returns scalars unchanged", () => {
    expect(scrubObsValue(42)).toBe(42);
    expect(scrubObsValue("hello")).toBe("hello");
    expect(scrubObsValue(null)).toBe(null);
    expect(scrubObsValue(undefined)).toBe(undefined);
    expect(scrubObsValue(true)).toBe(true);
  });

  it("defends against deeply nested structures with a depth guard (no stack overflow)", () => {
    // Build a 50-deep nested object. The scrubber must not blow the stack.
    type Nested = { next?: Nested; tenant_id?: string; keep?: number };
    const root: Nested = {};
    let cursor: Nested = root;
    for (let i = 0; i < 50; i++) {
      cursor.next = { keep: i, tenant_id: `uuid-${i}` };
      cursor = cursor.next;
    }
    const out = scrubObsValue(root) as Nested;
    // Walk the first few levels — every `tenant_id` must be gone.
    let probe: Nested | undefined = out.next;
    let checked = 0;
    while (probe && checked < 5) {
      expect(probe).not.toHaveProperty("tenant_id");
      expect(probe).toHaveProperty("keep");
      probe = probe.next;
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe("summarizeErrorForObs — tame error strings before they carry DB params to the log", () => {
  it("keeps only the first line and caps at 80 chars for a Postgres-style multi-line error", () => {
    // Synthesized shape of a drizzle-orm/postgres-js error: the message
    // includes the SQL + a "params: <uuid>, <uuid>, ..." tail. Our shim
    // would JSON.stringify this cause string verbatim and leak the UUIDs.
    const pgError = new Error(
      'Failed query: insert into "audit_payloads" ("correlation_id", "kind", "tenant_id") values ($1, $2, $3)\nparams: fc782441-a62d-465a-bcf0-f7dbfe674cf1,after,dc70fd41-d28f-4e48-ada7-a92979ac2d5d',
    );
    const out = summarizeErrorForObs(pgError);
    expect(out).not.toContain("fc782441-a62d-465a-bcf0-f7dbfe674cf1");
    expect(out).not.toContain("dc70fd41-d28f-4e48-ada7-a92979ac2d5d");
    expect(out).not.toContain("params:");
    expect(out.startsWith("Error:")).toBe(true);
  });

  it("preserves error name for subclasses", () => {
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "CustomError";
      }
    }
    expect(summarizeErrorForObs(new CustomError("boom"))).toBe("CustomError: boom");
  });

  it("handles non-Error values by coercing to string and capping", () => {
    const longValue = "x".repeat(200);
    const out = summarizeErrorForObs(longValue);
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it("handles undefined / null without throwing", () => {
    expect(summarizeErrorForObs(undefined)).toBe("undefined");
    expect(summarizeErrorForObs(null)).toBe("null");
  });
});

describe("captureMessage — scrubs at the funnel before dispatch", () => {
  it("drops extra.actor_id / extra.token_id / tags.tenant_id before calling the underlying sink", () => {
    const spy = vi.fn();
    const fake: SentryLike = { captureMessage: spy };
    __setSentryForTests(fake);

    captureMessage("audit_write_failure", {
      level: "error",
      tags: {
        tenant_id: "00000000-0000-0000-0000-000000000001",
        operation: "auth.signup",
        code: "validation_failed",
      },
      extra: {
        actor_id: "00000000-0000-0000-0000-000000000002",
        token_id: "00000000-0000-0000-0000-000000000003",
        cause: "Error: DB down",
        raw_input_bytes: 512,
      },
    });

    expect(spy).toHaveBeenCalledOnce();
    const [name, options] = spy.mock.calls[0]!;
    expect(name).toBe("audit_write_failure");
    expect(options.level).toBe("error");
    // Operational tags preserved.
    expect(options.tags).toEqual({
      operation: "auth.signup",
      code: "validation_failed",
    });
    // Identifier fields dropped; operational extras preserved.
    expect(options.extra).toEqual({
      cause: "Error: DB down",
      raw_input_bytes: 512,
    });
    // Belt-and-braces: no identifier values appear anywhere in the payload.
    const joined = JSON.stringify(options);
    expect(joined).not.toContain("00000000-0000-0000-0000-000000000001");
    expect(joined).not.toContain("00000000-0000-0000-0000-000000000002");
    expect(joined).not.toContain("00000000-0000-0000-0000-000000000003");
  });

  it("drops host and user_id from the BA tenant-resolution-lost hook payload", () => {
    const spy = vi.fn();
    __setSentryForTests({ captureMessage: spy });

    captureMessage("audit_write_failure", {
      level: "error",
      tags: {
        reason: "tenant_resolution_lost_at_hook",
        operation: "auth.signup",
      },
      extra: { user_id: "user-uuid", host: "shop.example.com" },
    });

    const [, options] = spy.mock.calls[0]!;
    expect(options.tags).toEqual({
      reason: "tenant_resolution_lost_at_hook",
      operation: "auth.signup",
    });
    expect(options.extra).toEqual({});
    const joined = JSON.stringify(options);
    expect(joined).not.toContain("user-uuid");
    expect(joined).not.toContain("shop.example.com");
  });

  it("drops hostname variants too (Host, HOSTNAME, hostname)", () => {
    const spy = vi.fn();
    __setSentryForTests({ captureMessage: spy });

    captureMessage("some_event", {
      extra: {
        Host: "a.example.com",
        HOSTNAME: "b.example.com",
        hostname: "c.example.com",
        keep: "yes",
      },
    });

    const [, options] = spy.mock.calls[0]!;
    expect(options.extra).toEqual({ keep: "yes" });
  });

  it("passes through calls with no options", () => {
    const spy = vi.fn();
    __setSentryForTests({ captureMessage: spy });

    captureMessage("some_event");

    expect(spy).toHaveBeenCalledWith("some_event", undefined);
  });

  it("passes through calls with options that have no tags or extra", () => {
    const spy = vi.fn();
    __setSentryForTests({ captureMessage: spy });

    captureMessage("some_event", { level: "info" });

    expect(spy).toHaveBeenCalledWith("some_event", { level: "info" });
  });
});
