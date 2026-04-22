/**
 * `CreateAccessTokenInputSchema` strict-mode — sub-chunk 7.5 (security C-1).
 *
 * The schema must be `.strict()`: unknown top-level keys (including the
 * adversarial `tenantId` / `userId` fields) must be rejected at parse
 * time. The HTTP-path Playwright test proves this end-to-end; this unit
 * test nails down the schema invariant so a future refactor that turns
 * `.strict()` back into `.passthrough()` (or the default lax mode) blows
 * up loudly in CI instead of silently widening the attack surface.
 */
import { describe, expect, it } from "vitest";
import { CreateAccessTokenInputSchema } from "@/server/services/tokens/create-access-token";

describe("CreateAccessTokenInputSchema — strict-mode (security C-1)", () => {
  const base = {
    name: "t",
    scopes: { role: "staff" as const },
  };

  it("rejects an adversarial tenantId field", () => {
    const result = CreateAccessTokenInputSchema.safeParse({
      ...base,
      tenantId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const codes = result.error.issues.map((i) => i.code);
      expect(codes).toContain("unrecognized_keys");
    }
  });

  it("rejects an adversarial userId field", () => {
    const result = CreateAccessTokenInputSchema.safeParse({
      ...base,
      userId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.code)).toContain("unrecognized_keys");
    }
  });

  it("rejects an arbitrary extra key", () => {
    const result = CreateAccessTokenInputSchema.safeParse({
      ...base,
      foo: "bar",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.code)).toContain("unrecognized_keys");
    }
  });

  it("rejects an empty-string-keyed extra field", () => {
    const result = CreateAccessTokenInputSchema.safeParse({
      ...base,
      "": "whatever",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.code)).toContain("unrecognized_keys");
    }
  });

  it("accepts a clean input with only allowed keys", () => {
    const result = CreateAccessTokenInputSchema.safeParse(base);
    expect(result.success).toBe(true);
  });
});
