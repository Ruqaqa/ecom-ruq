/**
 * The chunk-4 stubbed resolver has been replaced by the DB-backed resolver
 * at src/server/tenant.ts. Its tests live at tests/unit/tenant/resolver.test.ts.
 * This file is retained as a deliberate sanity placeholder so future test
 * harness wiring has a known-cheap smoke test.
 */
import { describe, it, expect } from "vitest";

describe("sanity", () => {
  it("vitest boots", () => {
    expect(1 + 1).toBe(2);
  });
});
