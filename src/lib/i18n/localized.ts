import { z } from "zod";

/**
 * 16KB cap on the JSON-serialized localized-text payload. Bounds the
 * audit hash-chain payload size per mutation, which keeps the per-tenant
 * advisory-lock window from being stretched by a single hostile request
 * (a 100MB product name would block every other auth / catalog write for
 * the same tenant while it canonicalizes and hashes). The per-field `max`
 * argument enforces field-specific human limits on top of this cap.
 */
const MAX_SERIALIZED_BYTES = 16 * 1024;

function withinCap(o: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(o), "utf8") <= MAX_SERIALIZED_BYTES;
}

/**
 * Factory: both locales required. Per-field `max` caller-specified
 * (slug vs name vs description have different human limits). The 16KB
 * serialized cap is constant across all callers.
 */
export function localizedText(opts: { max: number }) {
  return z
    .object({
      en: z.string().min(1).max(opts.max),
      ar: z.string().min(1).max(opts.max),
    })
    .refine(withinCap, { message: "localized text exceeds 16KB cap" });
}

/**
 * Factory: both locales optional, but at least one must be present. The
 * 16KB cap still applies; missing-translation content falls back silently
 * per prd.md §3.2 (admin surfaces the badge; storefront stays readable).
 */
export function localizedTextPartial(opts: { max: number }) {
  return z
    .object({
      en: z.string().min(1).max(opts.max).optional(),
      ar: z.string().min(1).max(opts.max).optional(),
    })
    .refine((o) => o.en !== undefined || o.ar !== undefined, {
      message: "at least one locale must be present",
    })
    .refine(withinCap, { message: "localized text exceeds 16KB cap" });
}

/**
 * Stable type exports. The catalog schema's JSONB `$type<LocalizedText>()`
 * casts continue to match — these type shapes are locale-complete / partial
 * regardless of the per-field max chosen by the factory caller. Under
 * `exactOptionalPropertyTypes`, optional properties carry explicit
 * `| undefined` so parsed output (which may include undefined from Zod's
 * `.optional()`) round-trips.
 */
export type LocalizedText = { en: string; ar: string };
export type LocalizedTextPartial = { en?: string | undefined; ar?: string | undefined };
