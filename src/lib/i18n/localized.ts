import { z } from "zod";

export const localizedText = z.object({ en: z.string(), ar: z.string() });
export type LocalizedText = z.infer<typeof localizedText>;

export const localizedTextPartial = z.object({
  en: z.string().optional(),
  ar: z.string().optional(),
});
export type LocalizedTextPartial = z.infer<typeof localizedTextPartial>;
