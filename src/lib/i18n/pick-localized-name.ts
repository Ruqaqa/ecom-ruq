// Picks the viewer-locale display text from a bilingual value, falling
// back to the other locale and flagging fallbacks so admin surfaces can
// show a "translation missing" badge. Returns `text: null` when both
// locales are missing — callers render their own translated placeholder.

export interface LocalizedText {
  en?: string | null | undefined;
  ar?: string | null | undefined;
}

export type Locale = "en" | "ar";

export interface PickedName {
  text: string | null;
  isFallback: boolean;
  fallbackLocale: Locale | null;
}

function present(v: string | null | undefined): v is string {
  return typeof v === "string" && v.length > 0;
}

export function pickLocalizedName(
  name: LocalizedText | null | undefined,
  locale: Locale,
): PickedName {
  if (name == null) {
    return { text: null, isFallback: true, fallbackLocale: null };
  }
  const other: Locale = locale === "en" ? "ar" : "en";
  const preferred = name[locale];
  if (present(preferred)) {
    return { text: preferred, isFallback: false, fallbackLocale: null };
  }
  const otherValue = name[other];
  if (present(otherValue)) {
    return { text: otherValue, isFallback: true, fallbackLocale: other };
  }
  return { text: null, isFallback: true, fallbackLocale: null };
}
