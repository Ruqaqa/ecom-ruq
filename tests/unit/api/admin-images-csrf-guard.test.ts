/**
 * Chunk 1a.7.2 Block 8 — `assertSameOriginMutation` and
 * `assertSameOriginRead` helper unit tests.
 *
 * Pure helpers — no network, no DB. We exercise every policy branch
 * directly against a constructed `Request`.
 */
import { describe, expect, it } from "vitest";
import {
  assertSameOriginMutation,
  assertSameOriginRead,
} from "@/app/api/admin/images/_shared";

function makeReq(opts: {
  url: string;
  headers?: Record<string, string>;
}): Request {
  return new Request(opts.url, {
    method: "POST",
    ...(opts.headers ? { headers: opts.headers } : {}),
  });
}

describe("assertSameOriginMutation", () => {
  it("accepts when Origin matches the request host", () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/upload",
      headers: { origin: "http://shop.example" },
    });
    expect(assertSameOriginMutation(req)).toBeNull();
  });

  it("rejects 403 when Origin host differs from the request host", async () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/upload",
      headers: { origin: "https://evil.example" },
    });
    const res = assertSameOriginMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("rejects 403 when Origin is malformed", () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/upload",
      headers: { origin: "not-a-url" },
    });
    const res = assertSameOriginMutation(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("falls back to Referer when Origin is missing", () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/upload",
      headers: { referer: "http://shop.example/admin/products" },
    });
    expect(assertSameOriginMutation(req)).toBeNull();
  });

  it("rejects 403 when only a mismatched Referer is present", () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/upload",
      headers: { referer: "https://evil.example/x" },
    });
    const res = assertSameOriginMutation(req);
    expect(res!.status).toBe(403);
  });

  it("accepts when Authorization is a Bearer token (PAT path)", () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/upload",
      headers: { authorization: "Bearer pat_abc123" },
    });
    expect(assertSameOriginMutation(req)).toBeNull();
  });

  it("accepts case-insensitive 'bearer' prefix", () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/upload",
      headers: { authorization: "bearer pat_abc123" },
    });
    expect(assertSameOriginMutation(req)).toBeNull();
  });

  it("rejects 403 when neither Origin, Referer, nor Bearer is present", () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/upload",
    });
    const res = assertSameOriginMutation(req);
    expect(res!.status).toBe(403);
  });
});

describe("assertSameOriginRead", () => {
  it("accepts when Sec-Fetch-Site is same-origin", () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/x",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(assertSameOriginRead(req)).toBeNull();
  });

  it("accepts when Sec-Fetch-Site is none (address-bar / direct nav)", () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/x",
      headers: { "sec-fetch-site": "none" },
    });
    expect(assertSameOriginRead(req)).toBeNull();
  });

  it("rejects 403 when Sec-Fetch-Site is cross-site", async () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/x",
      headers: { "sec-fetch-site": "cross-site" },
    });
    const res = assertSameOriginRead(req);
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("rejects 403 when Sec-Fetch-Site is same-site (cross-origin same-eTLD)", () => {
    const req = makeReq({
      url: "http://shop.example/api/admin/images/x",
      headers: { "sec-fetch-site": "same-site" },
    });
    const res = assertSameOriginRead(req);
    expect(res!.status).toBe(403);
  });

  it("accepts (falls through) when Sec-Fetch-Site is absent (older browser / programmatic)", () => {
    const req = makeReq({ url: "http://shop.example/api/admin/images/x" });
    expect(assertSameOriginRead(req)).toBeNull();
  });
});
