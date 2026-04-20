/**
 * `isSafeReturnTo(path)` — post-verify `?returnTo=` query whitelist.
 *
 * Rejects absolute URLs, protocol-relative URLs, backslash tricks, path
 * traversal, and non-string inputs. Accepts only paths that begin with a
 * single `/` and stay on the same origin.
 */
import { describe, it, expect } from "vitest";
import { isSafeReturnTo } from "@/server/auth/return-to";

describe("isSafeReturnTo", () => {
  it("accepts a leading-slash relative path", () => {
    expect(isSafeReturnTo("/ar/cart")).toBe(true);
    expect(isSafeReturnTo("/en/account/orders")).toBe(true);
    expect(isSafeReturnTo("/")).toBe(true);
  });

  it("rejects absolute URLs (http/https)", () => {
    expect(isSafeReturnTo("https://attacker.com")).toBe(false);
    expect(isSafeReturnTo("http://brand-a.com/path")).toBe(false);
    expect(isSafeReturnTo("HTTPS://EVIL.com")).toBe(false);
  });

  it("rejects protocol-relative URLs (//host)", () => {
    expect(isSafeReturnTo("//attacker.com")).toBe(false);
    expect(isSafeReturnTo("//attacker.com/path")).toBe(false);
  });

  it("rejects backslash host smuggling", () => {
    expect(isSafeReturnTo("/\\attacker.com")).toBe(false);
    expect(isSafeReturnTo("\\/attacker.com")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isSafeReturnTo("/../../etc/passwd")).toBe(false);
    expect(isSafeReturnTo("/ar/../secret")).toBe(false);
  });

  it("rejects javascript: / data: / other schemes", () => {
    expect(isSafeReturnTo("javascript:alert(1)")).toBe(false);
    expect(isSafeReturnTo("data:text/html,x")).toBe(false);
    expect(isSafeReturnTo("mailto:a@b.com")).toBe(false);
  });

  it("rejects empty, null, and non-string values", () => {
    expect(isSafeReturnTo("")).toBe(false);
    expect(isSafeReturnTo(null)).toBe(false);
    expect(isSafeReturnTo(undefined)).toBe(false);
    expect(isSafeReturnTo(42 as unknown as string)).toBe(false);
  });

  it("rejects paths without a leading slash", () => {
    expect(isSafeReturnTo("ar/cart")).toBe(false);
    expect(isSafeReturnTo("foo")).toBe(false);
  });

  it("allows a query string and hash", () => {
    expect(isSafeReturnTo("/en/products?sort=price#top")).toBe(true);
  });

  it("rejects control characters and newlines (header/response smuggling)", () => {
    expect(isSafeReturnTo("/ar/x\nhost:evil")).toBe(false);
    expect(isSafeReturnTo("/ar/\rX")).toBe(false);
    expect(isSafeReturnTo("/ar/\u0000bad")).toBe(false);
  });
});
