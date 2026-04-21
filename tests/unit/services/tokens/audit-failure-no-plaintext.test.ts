/**
 * S-13 canary — if the audit insert itself throws during a PAT issuance,
 * the `writeAuditInOwnTx` best-effort path captures a Sentry
 * `audit_write_failure` message. The plaintext PAT must not surface in
 * that Sentry extra / tag / console output.
 *
 * We drive `writeAuditInOwnTx` DIRECTLY with a payload that contains a
 * synthetic `eruq_pat_<canary>` inside `row.input` — simulating a
 * caller that accidentally handed the audit path the plaintext. The
 * underlying `insertAuditInTx` is forced to throw (bogus tenant_id,
 * FK reject), which routes through the Sentry shim. We assert the
 * captured payload:
 *   - HAS the `audit_write_failure` event (non-vacuity);
 *   - has `raw_input_bytes` as a NUMBER, not a string echo of row.input
 *     (the canonicalJson path must only measure bytes, never emit them);
 *   - contains no `eruq_pat_` substring anywhere in tags/extra;
 *   - and no canonical plaintext echo.
 *
 * This pins the Sentry-shim contract: byte count only, no body echo.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { __setSentryForTests, type SentryLike } from "@/server/obs/sentry";
import { writeAuditInOwnTx } from "@/server/audit/write";

beforeAll(() => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");
  if (!env.TOKEN_HASH_PEPPER) env.TOKEN_HASH_PEPPER = randomBytes(32).toString("base64");
});

afterAll(() => {
  __setSentryForTests(null);
});

describe("writeAuditInOwnTx captures no plaintext on audit_write_failure (S-13)", () => {
  it("Sentry extra contains raw_input_bytes (number), cause (error string) — NEVER the PAT plaintext", async () => {
    const captures: Array<{ name: string; options?: unknown }> = [];
    const spy: SentryLike = {
      captureMessage(name, options) {
        captures.push({ name, options });
      },
    };
    __setSentryForTests(spy);

    const canaryPlaintext = "eruq_pat_CANARY_CANARY_CANARY";
    // Invalid tenant_id (bogus UUID) → FK violation inside insertAuditInTx,
    // triggering the catch → Sentry capture path.
    await writeAuditInOwnTx({
      tenantId: "00000000-0000-0000-0000-000000000000",
      operation: "tokens.create",
      actorType: "user",
      actorId: null,
      tokenId: null,
      outcome: "success",
      // The input that the service's (imaginary) caller handed us. Under
      // normal operation the `plaintext` key gets redacted by the belt-and
      // -braces matcher BEFORE hashing. But the Sentry shim stringifies
      // `row.input` raw into `extra.raw_input_bytes`'s CANONICALJSON
      // byte count — which is a number, not a string echo. This test
      // pins that invariant.
      input: { plaintext: canaryPlaintext, name: "whatever" },
    });

    // Non-vacuity: the capture must have fired.
    expect(captures.length).toBeGreaterThanOrEqual(1);
    const audit = captures.find((c) => c.name === "audit_write_failure");
    expect(audit).toBeDefined();

    const joined = JSON.stringify(captures);
    expect(joined).not.toContain(canaryPlaintext);
    expect(joined).not.toContain("eruq_pat_");

    // Structural: extra.raw_input_bytes is a number, not a string echo.
    const opts = audit!.options as {
      extra?: { raw_input_bytes?: unknown; cause?: unknown };
    };
    expect(typeof opts.extra?.raw_input_bytes).toBe("number");
  });
});
