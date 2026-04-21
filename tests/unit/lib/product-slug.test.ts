/**
 * `src/lib/product-slug.ts` — single source of truth for slug shape,
 * shared between server Zod and the admin form's live validation +
 * auto-derivation. These tests lock both the deterministic slugify
 * output and the closed-set validateSlug error keys.
 */
import { describe, it, expect } from "vitest";
import {
  slugify,
  validateSlug,
  SLUG_MAX,
} from "@/lib/product-slug";

describe("slugify", () => {
  it("lowercases and hyphenates plain ASCII", () => {
    expect(slugify("AirPods Pro 2")).toBe("airpods-pro-2");
  });

  it("NFKD-decomposes diacritics ('café' → 'cafe') and trims whitespace", () => {
    expect(slugify("  Café Con Leche  ")).toBe("cafe-con-leche");
  });

  it("strips non-Latin script (Greek α → hyphen-bridged, only [a-z0-9] survive)", () => {
    // 'α' is Greek U+03B1, not diacritic; falls through to the
    // [^a-z0-9] pass and becomes a hyphen. Consecutive hyphens collapse.
    expect(slugify("Sony α7 IV")).toBe("sony-7-iv");
  });

  it("collapses consecutive hyphens", () => {
    expect(slugify("foo---bar")).toBe("foo-bar");
  });

  it("returns empty string when input has no slug-safe characters", () => {
    expect(slugify("---")).toBe("");
    expect(slugify("")).toBe("");
  });

  it("drops Arabic script; remaining Latin survives", () => {
    expect(slugify("سوني-a7iv")).toBe("a7iv");
  });

  it("caps length at SLUG_MAX (120)", () => {
    expect(slugify("a".repeat(200)).length).toBe(SLUG_MAX);
  });

  it("does not leave a trailing hyphen when the cap falls on one", () => {
    // 119 'a's + '-b' would become 120 chars if sliced at 120: 'a'×119 + '-'.
    // The final `-+$` trim must strip the trailing hyphen.
    const out = slugify("a".repeat(119) + "-b");
    expect(out.endsWith("-")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(SLUG_MAX);
  });
});

describe("validateSlug", () => {
  it("returns 'empty' on empty string", () => {
    expect(validateSlug("")).toBe("empty");
  });

  it("returns 'too_long' when over SLUG_MAX", () => {
    expect(validateSlug("a".repeat(SLUG_MAX + 1))).toBe("too_long");
  });

  it("returns 'invalid_chars' on uppercase", () => {
    expect(validateSlug("Foo")).toBe("invalid_chars");
  });

  it("returns 'leading_hyphen' on leading hyphen", () => {
    expect(validateSlug("-foo")).toBe("leading_hyphen");
  });

  it("returns 'trailing_hyphen' on trailing hyphen", () => {
    expect(validateSlug("foo-")).toBe("trailing_hyphen");
  });

  it("returns 'consecutive_hyphens' on a double hyphen", () => {
    expect(validateSlug("foo--bar")).toBe("consecutive_hyphens");
  });

  it("returns null on a shape-valid slug", () => {
    expect(validateSlug("valid-slug-123")).toBe(null);
  });
});
