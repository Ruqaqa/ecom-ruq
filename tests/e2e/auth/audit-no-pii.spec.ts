/**
 * Block 8 PII-absence canary — four flows.
 *
 * Threat model: the block-2 High-01 fix bounds what the audit chain
 * can ever hold: error columns are a closed-set JSON shape, input
 * payloads on validation failures are field-paths-only (not values),
 * non-validation failures skip the `input` column entirely. This spec
 * is the regression lock at the HTTP layer: for every failure path a
 * user can hit from the browser, neither the caller-supplied email
 * nor the caller-supplied password may appear anywhere in new
 * `audit_log` / `audit_payloads` rows.
 *
 * Four flows, one canary pair:
 *   Flow 1 — password too short (BA rejects sub-10-char password).
 *   Flow 2 — breached password (BA's pre-hash breach-list hook
 *            throws PASSWORD_COMPROMISED).
 *   Flow 3 — magic-link rate-limit-exceeded. 4 hits against
 *            /sign-in/magic-link saturate the per-email 3/15min
 *            tier. Uses the x-dev-only-enforce-rate-limit opt-out
 *            header so the E2E bypass doesn't neutralize the test.
 *   Flow 4 — successful signup (happy path).
 *
 * Plus: the 413 adapter-cap path writes NO audit row (body is
 * rejected before `fetchRequestHandler` + audit-wrap see it).
 *
 * Canary strings appear as literals here so a grep unambiguously
 * maps intent to code. They MUST NOT appear anywhere in the audit
 * rows under any flow.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const TENANT_HOST = "localhost:5001";
const BASE_URL = "http://localhost:5001";

const CANARY_EMAIL_BASE = "canary-pii-leak";
const CANARY_PASSWORD = "PIIPassword!CanaryLeak2026";
// 12-char breached password (from src/server/auth/data/top-common-passwords.json)
// that passes the 10-char min so BA reaches the breached-password hook.
const BREACHED_CANARY_PASSWORD = "password123";

function canaryEmail(tag: string): string {
  return `${CANARY_EMAIL_BASE}-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

interface AuditRow {
  id: string;
  tenant_id: string;
  operation: string;
  outcome: string;
  error: string | null;
  actor_id: string | null;
  correlation_id: string;
}

interface AuditPayloadRow {
  correlation_id: string;
  kind: string;
  payload: unknown;
}

async function snapshotAuditTail(tenantHost: string): Promise<string> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ ts: string }>>`
      SELECT COALESCE(MAX(al.created_at), 'epoch'::timestamptz)::text AS ts
      FROM audit_log al
      JOIN tenants t ON t.id = al.tenant_id
      WHERE t.primary_domain = ${tenantHost}
    `;
    return rows[0]?.ts ?? "epoch";
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface AuditBundle {
  log: AuditRow[];
  payloads: AuditPayloadRow[];
}

async function readNewAuditRows(
  tenantHost: string,
  sinceTs: string,
): Promise<AuditBundle> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const log = await sql<AuditRow[]>`
      SELECT al.id::text AS id,
             al.tenant_id::text AS tenant_id,
             al.operation, al.outcome, al.error, al.actor_id,
             al.correlation_id::text AS correlation_id
      FROM audit_log al
      JOIN tenants t ON t.id = al.tenant_id
      WHERE t.primary_domain = ${tenantHost}
        AND al.created_at > ${sinceTs}::timestamptz
    `;
    const payloads = await sql<AuditPayloadRow[]>`
      SELECT ap.correlation_id::text AS correlation_id, ap.kind, ap.payload
      FROM audit_payloads ap
      JOIN tenants t ON t.id = ap.tenant_id
      WHERE t.primary_domain = ${tenantHost}
        AND ap.correlation_id IN (
          SELECT al.correlation_id
          FROM audit_log al
          JOIN tenants t2 ON t2.id = al.tenant_id
          WHERE t2.primary_domain = ${tenantHost}
            AND al.created_at > ${sinceTs}::timestamptz
        )
    `;
    return { log: [...log], payloads: [...payloads] };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function deleteCanaryUser(email: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`DELETE FROM "user" WHERE email = ${email}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const ERROR_JSON_RE =
  /^\{"code":"(validation_failed|not_found|forbidden|conflict|rls_denied|rate_limited|serialization_failure|internal_error)"\}$/;

function assertNoCanaryAndClosedSetErrors(
  bundle: AuditBundle,
  canaryEmailValue: string,
): void {
  const fullDump = JSON.stringify(bundle);
  expect(fullDump).not.toContain(canaryEmailValue);
  expect(fullDump).not.toContain(CANARY_PASSWORD);
  expect(fullDump).not.toContain(BREACHED_CANARY_PASSWORD);
  // Also the email prefix (no timestamp) to catch future truncation.
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

async function signUpHttp(
  request: APIRequestContext,
  email: string,
  password: string,
  extraHeaders: Record<string, string> = {},
): Promise<number> {
  const res = await request.post(`${BASE_URL}/api/auth/sign-up/email`, {
    headers: { "content-type": "application/json", ...extraHeaders },
    data: { email, password, name: "Canary Leak" },
  });
  return res.status();
}

async function magicLinkHttp(
  request: APIRequestContext,
  email: string,
  extraHeaders: Record<string, string> = {},
): Promise<number> {
  const res = await request.post(`${BASE_URL}/api/auth/sign-in/magic-link`, {
    headers: { "content-type": "application/json", ...extraHeaders },
    data: { email, callbackURL: `/en/account` },
  });
  return res.status();
}

test("PII-absence — Flow 1 (password too short) leaks neither email nor password into audit", async ({ request }) => {
  test.setTimeout(45_000);
  const email = canaryEmail("f1");
  const tail = await snapshotAuditTail(TENANT_HOST);

  try {
    const status = await signUpHttp(request, email, "abc");
    expect([400, 422]).toContain(status);

    await new Promise((r) => setTimeout(r, 200));
    const bundle = await readNewAuditRows(TENANT_HOST, tail);
    // Block 7: signup-failure audit now fires via hooks.after.
    expect(bundle.log.length).toBeGreaterThan(0);
    expect(
      bundle.log.some(
        (r) => r.operation === "auth.signup" && r.outcome === "failure",
      ),
    ).toBe(true);
    assertNoCanaryAndClosedSetErrors(bundle, email);
  } finally {
    await deleteCanaryUser(email);
  }
});

test("PII-absence — Flow 2 (breached password) leaks neither email nor password into audit", async ({ request }) => {
  test.setTimeout(45_000);
  const email = canaryEmail("f2");
  const tail = await snapshotAuditTail(TENANT_HOST);

  try {
    // password123 is in the committed breached list AND passes the 10-char
    // minimum, so BA reaches the breached-password hook that throws
    // PASSWORD_COMPROMISED.
    const status = await signUpHttp(request, email, BREACHED_CANARY_PASSWORD);
    expect([400, 422]).toContain(status);

    await new Promise((r) => setTimeout(r, 200));
    const bundle = await readNewAuditRows(TENANT_HOST, tail);
    // Block 7: signup-failure audit now fires via hooks.after.
    expect(bundle.log.length).toBeGreaterThan(0);
    expect(
      bundle.log.some(
        (r) => r.operation === "auth.signup" && r.outcome === "failure",
      ),
    ).toBe(true);
    assertNoCanaryAndClosedSetErrors(bundle, email);
  } finally {
    await deleteCanaryUser(email);
  }
});

test("PII-absence — Flow 3 (magic-link rate-limit-exceeded) writes rate_limited audit with neither email nor password", async ({ request }) => {
  test.setTimeout(45_000);
  const email = canaryEmail("f3");
  const tail = await snapshotAuditTail(TENANT_HOST);

  try {
    // /sign-in/magic-link idLimit = 3/15min. Send 4 times against the
    // canary email with x-dev-only-enforce-rate-limit: 1 so the E2E bypass
    // is disabled for THIS request (the opt-out header activates only
    // when APP_ENV=e2e, so it cannot widen prod surface). The 4th call
    // should trigger the rate-limit-exceeded audit write.
    const hdr = { "x-dev-only-enforce-rate-limit": "1" };
    for (let i = 0; i < 3; i++) {
      const s = await magicLinkHttp(request, email, hdr);
      expect(s).toBeLessThan(500);
    }
    const rejectStatus = await magicLinkHttp(request, email, hdr);
    expect(rejectStatus).toBe(429);

    await new Promise((r) => setTimeout(r, 200));
    const bundle = await readNewAuditRows(TENANT_HOST, tail);
    // At least one rate-limit-exceeded row should exist.
    const rlRows = bundle.log.filter(
      (r) => r.operation === "auth.rate-limit-exceeded" && r.outcome === "failure",
    );
    expect(rlRows.length).toBeGreaterThan(0);
    for (const row of rlRows) {
      expect(row.error).toBe(JSON.stringify({ code: "rate_limited" }));
    }
    assertNoCanaryAndClosedSetErrors(bundle, email);
  } finally {
    await deleteCanaryUser(email);
  }
});

test("PII-absence — Flow 4 (successful signup) leaks neither email nor password into audit", async ({ request }) => {
  test.setTimeout(45_000);
  const email = canaryEmail("f4");
  const tail = await snapshotAuditTail(TENANT_HOST);

  try {
    const status = await signUpHttp(request, email, CANARY_PASSWORD);
    expect(status).toBeLessThan(400);

    await new Promise((r) => setTimeout(r, 200));
    const bundle = await readNewAuditRows(TENANT_HOST, tail);
    // Block 7: happy-path signup now audits at user.create.after.
    expect(bundle.log.length).toBeGreaterThan(0);
    expect(
      bundle.log.some(
        (r) => r.operation === "auth.signup" && r.outcome === "success",
      ),
    ).toBe(true);
    assertNoCanaryAndClosedSetErrors(bundle, email);
  } finally {
    await deleteCanaryUser(email);
  }
});

test("413 adapter body-cap writes NO products.create audit row (reject is pre-audit-wrap)", async ({ request }) => {
  test.setTimeout(15_000);
  const tail = await snapshotAuditTail(TENANT_HOST);

  const huge = "a".repeat(128 * 1024);
  const res = await request.post(`${BASE_URL}/api/trpc/products.create`, {
    headers: { "content-type": "application/json" },
    data: { blob: huge },
  });
  expect(res.status()).toBe(413);

  await new Promise((r) => setTimeout(r, 200));
  // We cannot assert "zero new rows in the window" because parallel
  // Playwright tests in the same tenant (e.g. Flow 3's
  // rate-limit-exceeded writes) land rows concurrently. What matters:
  // the adapter-cap short-circuits BEFORE `fetchRequestHandler` runs,
  // so audit-wrap never sees the call — there must be NO row whose
  // operation is 'products.create' (or any tRPC mutation). If one
  // exists, the body slipped past the cap and was parsed by tRPC.
  const bundle = await readNewAuditRows(TENANT_HOST, tail);
  const mutationRows = bundle.log.filter(
    (r) => r.operation === "products.create" || r.operation.startsWith("products."),
  );
  expect(
    mutationRows,
    "413-rejected body must not produce a products.* audit row",
  ).toEqual([]);
});
