import { request as playwrightRequest, type APIRequestContext } from "@playwright/test";

const MAILPIT_BASE = process.env.MAILPIT_URL ?? "http://localhost:58025";

export interface MailpitMessage {
  ID: string;
  From: { Address: string; Name: string };
  To: Array<{ Address: string; Name: string }>;
  Subject: string;
  Created: string;
}

export interface MailpitMessageBody {
  ID: string;
  Subject: string;
  HTML: string;
  Text: string;
}

async function withContext<T>(fn: (ctx: APIRequestContext) => Promise<T>): Promise<T> {
  const ctx = await playwrightRequest.newContext({ baseURL: MAILPIT_BASE });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

export async function clearMailpit(): Promise<void> {
  await withContext(async (ctx) => {
    const res = await ctx.delete("/api/v1/messages");
    if (!res.ok()) throw new Error(`Mailpit clear failed: ${res.status()}`);
  });
}

export async function waitForEmailTo(
  recipient: string,
  opts: { timeoutMs?: number; subjectIncludes?: string } = {},
): Promise<MailpitMessageBody> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const subjectFilter = opts.subjectIncludes;
  return withContext(async (ctx) => {
    while (Date.now() < deadline) {
      const res = await ctx.get(`/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`);
      if (res.ok()) {
        const data = (await res.json()) as { messages?: MailpitMessage[] };
        const match = subjectFilter
          ? data.messages?.find((m) => m.Subject.includes(subjectFilter))
          : data.messages?.[0];
        if (match) {
          const detail = await ctx.get(`/api/v1/message/${match.ID}`);
          if (detail.ok()) return (await detail.json()) as MailpitMessageBody;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for email to ${recipient}${subjectFilter ? ` matching '${subjectFilter}'` : ""}`);
  });
}

export function extractFirstLink(html: string, predicate?: (href: string) => boolean): string {
  const matches = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((x): x is string => typeof x === "string");
  const match = predicate ? matches.find(predicate) : matches[0];
  if (!match) throw new Error("No link found in email body");
  return match;
}
