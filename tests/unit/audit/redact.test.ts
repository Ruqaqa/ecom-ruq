import { describe, it, expect } from "vitest";
import {
  redactForAudit,
  DEFAULT_REGISTRY,
  BELT_AND_BRACES_PII_KEYS,
} from "@/server/audit/redact";

describe("redactForAudit", () => {
  it("replaces known Tier-A fields with a redaction marker", () => {
    const out = redactForAudit(
      { id: "abc", status: "verified", payload: Buffer.from("secret") },
      "identity_verifications",
    );
    expect(out.payload).toBe("[REDACTED_TIER_A]");
    expect(out.status).toBe("verified");
    expect(out.id).toBe("abc");
  });

  it("leaves unrelated entities untouched", () => {
    const obj = { id: "p1", name: { en: "Hat", ar: "قبعة" }, price: 1000 };
    expect(redactForAudit(obj, "products")).toBe(obj);
  });

  it("recurses into arrays", () => {
    const out = redactForAudit(
      [
        { id: "a", payload: Buffer.from("x") },
        { id: "b", payload: Buffer.from("y") },
      ],
      "identity_verifications",
    );
    expect(out[0]?.payload).toBe("[REDACTED_TIER_A]");
    expect(out[1]?.payload).toBe("[REDACTED_TIER_A]");
  });

  it("does not mutate the input", () => {
    const original = { id: "x", payload: Buffer.from("keep-me") };
    const copy = { ...original };
    redactForAudit(original, "identity_verifications");
    expect(original).toEqual(copy);
  });

  it("uses the default registry when none passed", () => {
    expect(DEFAULT_REGISTRY.identity_verifications).toContain("payload");
  });
});

describe("redactForAudit — BELT_AND_BRACES_PII_KEYS safety net", () => {
  it("exports the list with password / token / secret / card / nationalId entries", () => {
    const lower = BELT_AND_BRACES_PII_KEYS.map((k) => k.toLowerCase());
    for (const expected of [
      "password",
      "token",
      "secret",
      "cardnumber",
      "nationalid",
    ]) {
      expect(lower).toContain(expected);
    }
  });

  it("includes the extended identity/contact safety-net keys (email, phone, iban, refreshToken, bearer)", () => {
    const lower = BELT_AND_BRACES_PII_KEYS.map((k) => k.toLowerCase());
    for (const expected of ["email", "phone", "iban", "refreshtoken", "bearer"]) {
      expect(lower).toContain(expected);
    }
  });

  it("redacts email / phone / iban on mixed-case keys", () => {
    const out = redactForAudit(
      { Email: "a@b.c", PHONE: "+966500", Iban: "SA00...", other: "ok" },
      "default",
    );
    expect(out).toMatchObject({
      Email: "[REDACTED_SENSITIVE]",
      PHONE: "[REDACTED_SENSITIVE]",
      Iban: "[REDACTED_SENSITIVE]",
      other: "ok",
    });
  });

  it("redacts case-insensitive matches at the top level (Password, PASSWORD, password)", () => {
    const out = redactForAudit(
      { Password: "a", PASSWORD: "b", password: "c", safe: "keep" },
      "default",
    );
    expect(out).toMatchObject({
      Password: "[REDACTED_SENSITIVE]",
      PASSWORD: "[REDACTED_SENSITIVE]",
      password: "[REDACTED_SENSITIVE]",
      safe: "keep",
    });
  });

  it("recurses into nested objects so { a: { token } } is caught", () => {
    const out = redactForAudit(
      { a: { token: "xyz", safe: "ok" }, top: "visible" },
      "default",
    );
    expect(out).toMatchObject({
      a: { token: "[REDACTED_SENSITIVE]", safe: "ok" },
      top: "visible",
    });
  });

  it("composes with entity registry — both Tier-A and PII keys are replaced", () => {
    const out = redactForAudit(
      { payload: Buffer.from("x"), password: "p" },
      "identity_verifications",
    );
    expect(out.payload).toBe("[REDACTED_TIER_A]");
    expect((out as unknown as { password: string }).password).toBe(
      "[REDACTED_SENSITIVE]",
    );
  });

  it("recurses into arrays of objects", () => {
    const out = redactForAudit(
      [
        { token: "t1", id: 1 },
        { token: "t2", id: 2 },
      ],
      "default",
    );
    expect(out[0]?.token).toBe("[REDACTED_SENSITIVE]");
    expect(out[1]?.token).toBe("[REDACTED_SENSITIVE]");
    expect(out[0]?.id).toBe(1);
  });

  // Sub-chunk 7.1 (S-7): exact-key semantics canary for PAT surfaces.
  it("exact-key redacts `plaintext` and `tokenHash` (sub-chunk 7.1)", () => {
    const lower = BELT_AND_BRACES_PII_KEYS.map((k) => k.toLowerCase());
    expect(lower).toContain("plaintext");
    expect(lower).toContain("tokenhash");

    const out = redactForAudit(
      {
        plaintext: "eruq_pat_CANARY_DO_NOT_LEAK",
        tokenHash: Buffer.from("deadbeef"),
        token_hash: Buffer.from("cafebabe"),
        ok: "keep",
      },
      "default",
    ) as Record<string, unknown>;
    expect(out.plaintext).toBe("[REDACTED_SENSITIVE]");
    expect(out.tokenHash).toBe("[REDACTED_SENSITIVE]");
    expect(out.token_hash).toBe("[REDACTED_SENSITIVE]");
    expect(out.ok).toBe("keep");
    expect(JSON.stringify(out)).not.toContain("eruq_pat_");
  });

  // Documents the MATCHER CONTRACT explicitly: exact-key only. A renamed
  // key like `tokenPlaintext` is NOT matched. This is a contract guard,
  // not a gap: if a future caller renames a field, they must add the
  // new name to `BELT_AND_BRACES_PII_KEYS`. If this test starts failing,
  // the matcher has been widened to fuzzy-match — review S-7 before
  // shipping.
  it("matcher is exact-key: a renamed key like `tokenPlaintext` does NOT trigger redaction", () => {
    const out = redactForAudit(
      { tokenPlaintext: "eruq_pat_RENAMED_CANARY" },
      "default",
    ) as Record<string, unknown>;
    // Unchanged — documenting the matcher semantics, not endorsing the
    // behavior.
    expect(out.tokenPlaintext).toBe("eruq_pat_RENAMED_CANARY");
  });
});
