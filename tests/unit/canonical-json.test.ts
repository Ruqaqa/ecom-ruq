import { describe, it, expect } from "vitest";
import { canonicalJson } from "@/lib/canonical-json";

describe("canonicalJson (RFC 8785 JCS)", () => {
  it("emits the same bytes regardless of input key order", () => {
    const a = canonicalJson({ b: 1, a: 2, nested: { y: 3, x: 4 } });
    const b = canonicalJson({ a: 2, b: 1, nested: { x: 4, y: 3 } });
    expect(a).toBe(b);
  });

  it("serializes integers without a trailing dot or zero", () => {
    expect(canonicalJson({ n: 1 })).toBe('{"n":1}');
  });

  it("throws on non-serializable values", () => {
    expect(() => canonicalJson(() => 1)).toThrow();
  });
});
