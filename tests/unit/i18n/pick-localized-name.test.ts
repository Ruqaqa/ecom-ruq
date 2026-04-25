import { describe, it, expect } from "vitest";
import { pickLocalizedName } from "@/lib/i18n/pick-localized-name";

describe("pickLocalizedName", () => {
  describe("en preferred", () => {
    it("returns the en string when en is present and non-empty", () => {
      const out = pickLocalizedName({ en: "Camera", ar: "كاميرا" }, "en");
      expect(out).toEqual({
        text: "Camera",
        isFallback: false,
        fallbackLocale: null,
      });
    });

    it("falls back to ar when en is missing", () => {
      const out = pickLocalizedName({ ar: "كاميرا" }, "en");
      expect(out).toEqual({
        text: "كاميرا",
        isFallback: true,
        fallbackLocale: "ar",
      });
    });

    it("returns null text when both locales are missing", () => {
      const out = pickLocalizedName({}, "en");
      expect(out).toEqual({
        text: null,
        isFallback: true,
        fallbackLocale: null,
      });
    });
  });

  describe("ar preferred", () => {
    it("returns the ar string when ar is present and non-empty", () => {
      const out = pickLocalizedName({ en: "Camera", ar: "كاميرا" }, "ar");
      expect(out).toEqual({
        text: "كاميرا",
        isFallback: false,
        fallbackLocale: null,
      });
    });

    it("falls back to en when ar is missing", () => {
      const out = pickLocalizedName({ en: "Camera" }, "ar");
      expect(out).toEqual({
        text: "Camera",
        isFallback: true,
        fallbackLocale: "en",
      });
    });

    it("returns null text when both locales are missing", () => {
      const out = pickLocalizedName({}, "ar");
      expect(out).toEqual({
        text: null,
        isFallback: true,
        fallbackLocale: null,
      });
    });
  });

  describe("edge cases", () => {
    it("treats null input as both-missing", () => {
      const out = pickLocalizedName(null, "en");
      expect(out).toEqual({
        text: null,
        isFallback: true,
        fallbackLocale: null,
      });
    });

    it("treats undefined input as both-missing", () => {
      const out = pickLocalizedName(undefined, "en");
      expect(out).toEqual({
        text: null,
        isFallback: true,
        fallbackLocale: null,
      });
    });

    it("treats empty-string as missing (falls back to the other locale)", () => {
      const out = pickLocalizedName({ en: "", ar: "كاميرا" }, "en");
      expect(out).toEqual({
        text: "كاميرا",
        isFallback: true,
        fallbackLocale: "ar",
      });
    });
  });
});
