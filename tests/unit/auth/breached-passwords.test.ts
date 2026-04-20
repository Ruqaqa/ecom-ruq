/**
 * Breached-password v0: an in-memory Set<string> seeded from a committed
 * asset (`src/server/auth/data/top-common-passwords.json`). Phase 0 keeps
 * this simple — a bloom filter over HIBP's top-10k is a later refinement
 * tracked by TODO in the module. The current list is the few-hundred most
 * abused credentials, which is the long tail that actually drives account
 * takeovers — full k-anonymity via HIBP's range API is available as an
 * alternative (BA's `haveIBeenPwned` plugin) when we decide we want the
 * runtime dependency.
 */
import { describe, it, expect } from "vitest";
import { isBreachedPassword } from "@/server/auth/breached-passwords";

describe("isBreachedPassword", () => {
  it("rejects the most common passwords", () => {
    expect(isBreachedPassword("password")).toBe(true);
    expect(isBreachedPassword("123456")).toBe(true);
    expect(isBreachedPassword("qwerty")).toBe(true);
    expect(isBreachedPassword("letmein")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isBreachedPassword("Password")).toBe(true);
    expect(isBreachedPassword("PASSWORD")).toBe(true);
  });

  it("accepts a high-entropy password", () => {
    expect(isBreachedPassword("correct-horse-battery-staple-9183")).toBe(false);
    expect(isBreachedPassword("r7x!Kz2qP9#vM3nQ")).toBe(false);
  });

  it("accepts empty / non-string defensively (never report safe as breached)", () => {
    // The caller should also check `minPasswordLength` — we don't reject
    // empty/short strings here. This guards against false positives.
    expect(isBreachedPassword("")).toBe(false);
  });
});
