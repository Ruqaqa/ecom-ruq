import { describe, it, expect } from "vitest";
import { redactForAudit, DEFAULT_REGISTRY } from "@/server/audit/redact";

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
