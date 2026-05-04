/**
 * Block 8 PII-absence canary — HTTP-boundary integration test.
 *
 * Replaces the previous Tier-4 spec at `tests/e2e/auth/audit-no-pii.spec.ts`.
 * The previous spec ran 6× across the device/locale matrix and depended on
 * `pnpm build && pnpm start`; the contract under test (audit row shape +
 * canary-string absence) is wire-observable, so we exercise the BA POST
 * route handler directly. Same coverage, ~10× faster, no browser.
 *
 * Threat model (unchanged): the block-2 High-01 fix bounds what the audit
 * chain can ever hold. For every signup-failure path a user can hit, the
 * caller-supplied email and password MUST NOT appear anywhere in new
 * `audit_log` / `audit_payloads` rows.
 *
 * Four flows:
 *   Flow 1 — password too short.
 *   Flow 2 — breached password (`password123` → PASSWORD_COMPROMISED).
 *   Flow 3 — magic-link rate-limit-exceeded (4 hits saturate the per-email
 *            tier). Forces the per-IP path off via x-real-ip rotation,
 *            uses a real Redis-backed limiter.
 *   Flow 4 — successful signup (happy path).
 *
 * Canary strings are literals here so a grep unambiguously maps intent
 * to code. They MUST NOT appear anywhere in the audit rows under any
 * flow.
 *
 * The 413 adapter-cap sub-test from the old spec moved to its own
 * domain — body-cap is a tRPC HTTP-boundary concern, not an auth one,
 * and is already covered in the admin-images CSRF/upload tests + the
 * MCP body-cap integration test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { POST } from "@/app/api/auth/[...all]/route";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const client = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(client, { schema });

const CANARY_EMAIL_BASE = "canary-pii-leak";
const CANARY_PASSWORD = "PIIPassword!CanaryLeak2026";
// 12-char breached password (from src/server/auth/data/top-common-passwords.json)
// that passes the 10-char min so BA reaches the breached-password hook.
const BREACHED_CANARY_PASSWORD = "password123";

let tenantId: string;
let tenantHost: string;

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");
  if (!env.TOKEN_HASH_PEPPER) env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");

  // Self-seeded tenant — keeps the test independent of the dev seed and
  // safe to run in parallel with other suites (own host = own row space).
  tenantId = randomUUID();
  const slug = `audit-pii-${tenantId.slice(0, 8)}`;
  tenantHost = `${slug}.test.local`;
  await db.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${tenantId}, ${slug}, ${tenantHost}, 'en', ${"no-reply@" + tenantHost},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" }).replace(/'/g, "''")}'::jsonb`)}, 'active')
  `);
});

afterAll(async () => {
  // Best-effort canary-user cleanup; the seeded tenant + its audit rows
  // are intentionally left behind (matches the rate-limit-wire test's
  // pattern — tenant rows are cheap, audit rows have a FK back). Each
  // run uses a fresh tenant id so there's no cross-run interference.
  await db
    .execute(sql`DELETE FROM "user" WHERE email LIKE ${`${CANARY_EMAIL_BASE}-%@test.local`}`)
    .catch(() => undefined);
  await client.end({ timeout: 5 });
});

interface AuditRow extends Record<string, unknown> {
  id: string;
  operation: string;
  outcome: string;
  error: string | null;
  correlation_id: string;
}
interface AuditPayloadRow extends Record<string, unknown> {
  correlation_id: string;
  kind: string;
  payload: unknown;
}
interface AuditBundle {
  log: AuditRow[];
  payloads: AuditPayloadRow[];
}

async function snapshotTail(): Promise<string> {
  const rows = await db.execute<{ ts: string }>(sql`
    SELECT COALESCE(MAX(created_at), 'epoch'::timestamptz)::text AS ts
    FROM audit_log WHERE tenant_id = ${tenantId}::uuid
  `);
  const arr = Array.isArray(rows) ? rows : (rows as { rows?: Array<{ ts: string }> }).rows ?? [];
  return arr[0]?.ts ?? "epoch";
}

async function readNew(sinceTs: string): Promise<AuditBundle> {
  const log = await db.execute<AuditRow>(sql`
    SELECT id::text AS id, operation, outcome, error,
           correlation_id::text AS correlation_id
    FROM audit_log
    WHERE tenant_id = ${tenantId}::uuid AND created_at > ${sinceTs}::timestamptz
  `);
  const payloads = await db.execute<AuditPayloadRow>(sql`
    SELECT correlation_id::text AS correlation_id, kind, payload
    FROM audit_payloads
    WHERE tenant_id = ${tenantId}::uuid
      AND correlation_id IN (
        SELECT correlation_id FROM audit_log
        WHERE tenant_id = ${tenantId}::uuid AND created_at > ${sinceTs}::timestamptz
      )
  `);
  const logArr = Array.isArray(log) ? log : (log as { rows?: AuditRow[] }).rows ?? [];
  const payloadArr = Array.isArray(payloads) ? payloads : (payloads as { rows?: AuditPayloadRow[] }).rows ?? [];
  return { log: [...logArr], payloads: [...payloadArr] };
}

const ERROR_JSON_RE =
  /^\{"code":"(validation_failed|not_found|forbidden|conflict|rls_denied|rate_limited|serialization_failure|internal_error)"\}$/;

function assertNoCanaryAndClosedSetErrors(bundle: AuditBundle, canaryEmailValue: string): void {
  const fullDump = JSON.stringify(bundle);
  expect(fullDump).not.toContain(canaryEmailValue);
  expect(fullDump).not.toContain(CANARY_PASSWORD);
  expect(fullDump).not.toContain(BREACHED_CANARY_PASSWORD);
  // Email prefix (no timestamp tail) catches future truncation edges.
  expect(fullDump).not.toContain(CANARY_EMAIL_BASE);

  for (const row of bundle.log) {
    if (row.outcome === "failure") {
      expect(row.error, `row ${row.id} outcome=failure must carry closed-set error`).toMatch(
        ERROR_JSON_RE,
      );
    } else {
      expect(row.error).toBeNull();
    }
  }
}

function canaryEmail(tag: string): string {
  return `${CANARY_EMAIL_BASE}-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

function authRequest(path: string, body: object, ip: string): Request {
  // Per-flow IP keeps each flow off other flows' rate-limit buckets.
  return new Request(`http://${tenantHost}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept-language": "en",
      "x-real-ip": ip,
    },
    body: JSON.stringify(body),
  });
}

describe("PII-absence at the auth HTTP boundary — Tier 3", () => {
  it("Flow 1 — password too short leaks neither email nor password into audit", async () => {
    const email = canaryEmail("f1");
    const tail = await snapshotTail();

    const res = await POST(authRequest("/sign-up/email", { email, password: "abc", name: "Canary Leak" }, "10.0.1.1"));
    expect([400, 422]).toContain(res.status);

    await new Promise((r) => setTimeout(r, 100));
    const bundle = await readNew(tail);
    expect(bundle.log.length).toBeGreaterThan(0);
    expect(
      bundle.log.some((r) => r.operation === "auth.signup" && r.outcome === "failure"),
    ).toBe(true);
    assertNoCanaryAndClosedSetErrors(bundle, email);
  });

  it("Flow 2 — breached password leaks neither email nor password into audit", async () => {
    const email = canaryEmail("f2");
    const tail = await snapshotTail();

    const res = await POST(
      authRequest("/sign-up/email", { email, password: BREACHED_CANARY_PASSWORD, name: "Canary Leak" }, "10.0.2.1"),
    );
    expect([400, 422]).toContain(res.status);

    await new Promise((r) => setTimeout(r, 100));
    const bundle = await readNew(tail);
    expect(bundle.log.length).toBeGreaterThan(0);
    expect(
      bundle.log.some((r) => r.operation === "auth.signup" && r.outcome === "failure"),
    ).toBe(true);
    assertNoCanaryAndClosedSetErrors(bundle, email);
  });

  it("Flow 3 — magic-link rate-limit-exceeded writes rate_limited audit with neither email nor password", async () => {
    const email = canaryEmail("f3");
    const tail = await snapshotTail();

    // /sign-in/magic-link idLimit = 3/15min. 4 calls from the same IP +
    // same email → 4th saturates the per-email bucket and is rejected
    // with the rate_limited closed-set code.
    const ip = "10.0.3.1";
    for (let i = 0; i < 3; i++) {
      const r = await POST(authRequest("/sign-in/magic-link", { email, callbackURL: "/en/account" }, ip));
      // 200 (link sent) or 4xx (e.g., user not found) — both are <500.
      expect(r.status).toBeLessThan(500);
    }
    const reject = await POST(authRequest("/sign-in/magic-link", { email, callbackURL: "/en/account" }, ip));
    expect(reject.status).toBe(429);

    await new Promise((r) => setTimeout(r, 100));
    const bundle = await readNew(tail);
    const rlRows = bundle.log.filter(
      (r) => r.operation === "auth.rate-limit-exceeded" && r.outcome === "failure",
    );
    expect(rlRows.length).toBeGreaterThan(0);
    for (const row of rlRows) {
      expect(row.error).toBe(JSON.stringify({ code: "rate_limited" }));
    }
    assertNoCanaryAndClosedSetErrors(bundle, email);
  });

  it("Flow 4 — successful signup leaks neither email nor password into audit", async () => {
    const email = canaryEmail("f4");
    const tail = await snapshotTail();

    const res = await POST(
      authRequest("/sign-up/email", { email, password: CANARY_PASSWORD, name: "Canary Leak" }, "10.0.4.1"),
    );
    expect(res.status).toBeLessThan(400);

    await new Promise((r) => setTimeout(r, 100));
    const bundle = await readNew(tail);
    expect(bundle.log.length).toBeGreaterThan(0);
    expect(
      bundle.log.some((r) => r.operation === "auth.signup" && r.outcome === "success"),
    ).toBe(true);
    assertNoCanaryAndClosedSetErrors(bundle, email);
  });
});
