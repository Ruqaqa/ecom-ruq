/**
 * Block 2d — tightened `localizedText` / `localizedTextPartial` Zod schemas.
 *
 * Contract:
 *   - `localizedText({ max })` is a factory; per-field character max is
 *     caller-specified (slug vs name vs description differ). Both `en` and
 *     `ar` are required and must be at least 1 char.
 *   - A constant 16KB cap on the JSON-serialized form applies on every
 *     instance. It bounds the audit hash-chain payload size per mutation
 *     (keeping the per-tenant advisory-lock window tight against a single
 *     hostile request) in addition to the per-field limits.
 *   - `localizedTextPartial({ max })` — both locales optional, but at least
 *     one must be present. Same 16KB cap.
 *   - Type exports `LocalizedText` / `LocalizedTextPartial` continue to
 *     match the JSONB `$type` on products / categories. The factory is new;
 *     the existing bare type exports stay stable so the schema file does
 *     not churn.
 */
import { describe, it, expect } from "vitest";
import {
  localizedText,
  localizedTextPartial,
  type LocalizedText,
  type LocalizedTextPartial,
} from "@/lib/i18n/localized";

describe("localizedText (factory)", () => {
  it("accepts both locales present under the per-field max", () => {
    const schema = localizedText({ max: 120 });
    const parsed: LocalizedText = schema.parse({ en: "Hello", ar: "مرحبا" });
    expect(parsed.en).toBe("Hello");
    expect(parsed.ar).toBe("مرحبا");
  });

  it("rejects a missing locale", () => {
    const schema = localizedText({ max: 120 });
    expect(() => schema.parse({ en: "Hello" })).toThrow();
    expect(() => schema.parse({ ar: "مرحبا" })).toThrow();
  });

  it("rejects empty strings (min 1)", () => {
    const schema = localizedText({ max: 120 });
    expect(() => schema.parse({ en: "", ar: "x" })).toThrow();
    expect(() => schema.parse({ en: "x", ar: "" })).toThrow();
  });

  it("rejects a field over the per-field max", () => {
    const schema = localizedText({ max: 5 });
    expect(() => schema.parse({ en: "abcdef", ar: "ab" })).toThrow();
  });

  it("rejects total over the 16KB hash-chain cap even when per-field limit would allow it", () => {
    // Per-field max 20000 chars is > 16KB by itself; cap must still reject.
    const schema = localizedText({ max: 20000 });
    const big = "a".repeat(10000);
    expect(() => schema.parse({ en: big, ar: big })).toThrow(/16KB|too large|cap/i);
  });
});

describe("localizedTextPartial (factory)", () => {
  it("accepts only en present", () => {
    const schema = localizedTextPartial({ max: 120 });
    const parsed: LocalizedTextPartial = schema.parse({ en: "Only English" });
    expect(parsed.en).toBe("Only English");
  });

  it("accepts only ar present", () => {
    const schema = localizedTextPartial({ max: 120 });
    const parsed = schema.parse({ ar: "عربي فقط" });
    expect(parsed.ar).toBe("عربي فقط");
  });

  it("rejects when both locales are absent", () => {
    const schema = localizedTextPartial({ max: 120 });
    expect(() => schema.parse({})).toThrow();
  });

  it("still applies the 16KB cap", () => {
    const schema = localizedTextPartial({ max: 20000 });
    const big = "a".repeat(10000);
    expect(() => schema.parse({ en: big, ar: big })).toThrow(/16KB|too large|cap/i);
  });
});
