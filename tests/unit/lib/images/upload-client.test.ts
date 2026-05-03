/**
 * `uploadProductImage` / `replaceProductImage` — XHR-based multipart
 * upload wrappers (chunk 1a.7.2 Block 5b).
 *
 * Vitest runs in node; XMLHttpRequest is not built-in. We inject a
 * minimal mock onto globalThis for each test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  uploadProductImage,
  replaceProductImage,
} from "@/lib/images/upload-client";

interface MockXhrInstance {
  method: string;
  url: string;
  body: FormData | undefined;
  upload: { onprogress: ((ev: ProgressEvent) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  status: number;
  responseText: string;
  abortCalled: boolean;
  open(method: string, url: string): void;
  send(body: FormData): void;
  abort(): void;
}

let lastXhr: MockXhrInstance | null = null;
let scriptedResponse: { status: number; bodyText: string } | "network_error" =
  { status: 200, bodyText: "" };
let progressEvents: Array<{ loaded: number; total: number }> = [];

function installMockXhr(): void {
  lastXhr = null;
  class MockXhr implements MockXhrInstance {
    method = "";
    url = "";
    body: FormData | undefined = undefined;
    upload = { onprogress: null as ((ev: ProgressEvent) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    status = 0;
    responseText = "";
    abortCalled = false;
    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }
    send(body: FormData): void {
      this.body = body;
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- mock XHR test seam tracks the active instance for assertions
      const self = this;
      lastXhr = self;
      // Fire progress events synchronously so tests don't await.
      queueMicrotask(() => {
        for (const ev of progressEvents) {
          self.upload.onprogress?.({
            lengthComputable: true,
            loaded: ev.loaded,
            total: ev.total,
          } as ProgressEvent);
        }
        if (scriptedResponse === "network_error") {
          self.onerror?.();
          return;
        }
        self.status = scriptedResponse.status;
        self.responseText = scriptedResponse.bodyText;
        self.onload?.();
      });
    }
    abort(): void {
      this.abortCalled = true;
    }
  }
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest =
    MockXhr as unknown as typeof XMLHttpRequest;
}

function makeFile(): File {
  return new File([new Uint8Array(1024)], "p.jpg", { type: "image/jpeg" });
}

beforeEach(() => {
  scriptedResponse = { status: 200, bodyText: "" };
  progressEvents = [];
  installMockXhr();
});

afterEach(() => {
  delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  vi.useRealTimers();
});

describe("uploadProductImage", () => {
  it("posts multipart form-data to /api/admin/images/upload with image + metadata parts", async () => {
    scriptedResponse = {
      status: 200,
      bodyText: JSON.stringify({
        ok: true,
        image: { id: "img-1", productId: "p-1" },
      }),
    };
    const result = await uploadProductImage(makeFile(), {
      productId: "00000000-0000-0000-0000-000000000001",
      expectedUpdatedAt: "2026-05-02T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    expect(lastXhr?.method).toBe("POST");
    expect(lastXhr?.url).toBe("/api/admin/images/upload");
    const fd = lastXhr?.body as FormData;
    expect(fd.get("image")).toBeInstanceOf(File);
    const meta = JSON.parse(fd.get("metadata") as string);
    expect(meta).toMatchObject({
      productId: "00000000-0000-0000-0000-000000000001",
      expectedUpdatedAt: "2026-05-02T00:00:00.000Z",
    });
  });

  it("invokes onProgress with a 0-100 percent integer", async () => {
    progressEvents = [
      { loaded: 256, total: 1024 },
      { loaded: 1024, total: 1024 },
    ];
    scriptedResponse = {
      status: 200,
      bodyText: JSON.stringify({ image: { id: "img-1" } }),
    };
    const calls: number[] = [];
    await uploadProductImage(
      makeFile(),
      {
        productId: "00000000-0000-0000-0000-000000000001",
        expectedUpdatedAt: "2026-05-02T00:00:00.000Z",
      },
      { onProgress: (p) => calls.push(p) },
    );
    expect(calls).toEqual([25, 100]);
  });

  it("returns ok:true with image on 200", async () => {
    scriptedResponse = {
      status: 200,
      bodyText: JSON.stringify({ image: { id: "img-1", productId: "p-1" } }),
    };
    const result = await uploadProductImage(makeFile(), {
      productId: "00000000-0000-0000-0000-000000000001",
      expectedUpdatedAt: "2026-05-02T00:00:00.000Z",
    });
    if (result.ok) {
      expect(result.image.id).toBe("img-1");
    } else {
      throw new Error("expected ok=true");
    }
  });

  it("returns ok:false with closed-set wire code on 400", async () => {
    scriptedResponse = {
      status: 400,
      bodyText: JSON.stringify({ error: { code: "image_too_small" } }),
    };
    const result = await uploadProductImage(makeFile(), {
      productId: "00000000-0000-0000-0000-000000000001",
      expectedUpdatedAt: "2026-05-02T00:00:00.000Z",
    });
    expect(result).toEqual({ ok: false, code: "image_too_small" });
  });

  it("surfaces existingImageId on 409 image_duplicate_in_product", async () => {
    scriptedResponse = {
      status: 409,
      bodyText: JSON.stringify({
        error: { code: "image_duplicate_in_product" },
        existingImageId: "existing-1",
      }),
    };
    const result = await uploadProductImage(makeFile(), {
      productId: "00000000-0000-0000-0000-000000000001",
      expectedUpdatedAt: "2026-05-02T00:00:00.000Z",
    });
    expect(result).toEqual({
      ok: false,
      code: "image_duplicate_in_product",
      existingImageId: "existing-1",
    });
  });

  it("rejects with Error('aborted') and calls xhr.abort() on signal.abort()", async () => {
    // Hold the response indefinitely by using a script that never fires.
    scriptedResponse = { status: 200, bodyText: "" };
    const controller = new AbortController();
    let firedXhr: MockXhrInstance | null = null;
    // Patch send to NOT auto-resolve.
    class HangingXhr implements MockXhrInstance {
      method = "";
      url = "";
      body: FormData | undefined = undefined;
      upload = { onprogress: null as ((ev: ProgressEvent) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      status = 0;
      responseText = "";
      abortCalled = false;
      open(m: string, u: string): void {
        this.method = m;
        this.url = u;
      }
      send(b: FormData): void {
        this.body = b;
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- mock XHR test seam tracks the active instance for assertions
        firedXhr = this;
      }
      abort(): void {
        this.abortCalled = true;
      }
    }
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest =
      HangingXhr as unknown as typeof XMLHttpRequest;
    const promise = uploadProductImage(
      makeFile(),
      {
        productId: "00000000-0000-0000-0000-000000000001",
        expectedUpdatedAt: "2026-05-02T00:00:00.000Z",
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(promise).rejects.toThrow("aborted");
    expect(firedXhr).not.toBeNull();
    expect((firedXhr as unknown as MockXhrInstance).abortCalled).toBe(true);
  });
});

describe("replaceProductImage", () => {
  it("hardcodes confirm:true in metadata (never accepts from caller)", async () => {
    scriptedResponse = {
      status: 200,
      bodyText: JSON.stringify({ image: { id: "img-2" } }),
    };
    await replaceProductImage(makeFile(), {
      imageId: "00000000-0000-0000-0000-0000000000aa",
      expectedUpdatedAt: "2026-05-02T00:00:00.000Z",
    });
    const fd = lastXhr?.body as FormData;
    const meta = JSON.parse(fd.get("metadata") as string);
    expect(meta).toMatchObject({
      imageId: "00000000-0000-0000-0000-0000000000aa",
      expectedUpdatedAt: "2026-05-02T00:00:00.000Z",
      confirm: true,
    });
  });

  it("posts to /api/admin/images/replace", async () => {
    scriptedResponse = {
      status: 200,
      bodyText: JSON.stringify({ image: { id: "img-2" } }),
    };
    await replaceProductImage(makeFile(), {
      imageId: "00000000-0000-0000-0000-0000000000aa",
      expectedUpdatedAt: "2026-05-02T00:00:00.000Z",
    });
    expect(lastXhr?.url).toBe("/api/admin/images/replace");
  });

  it("returns ok:false with code on 409 stale_write (no existingImageId)", async () => {
    scriptedResponse = {
      status: 409,
      bodyText: JSON.stringify({ error: { code: "stale_write" } }),
    };
    const result = await replaceProductImage(makeFile(), {
      imageId: "00000000-0000-0000-0000-0000000000aa",
      expectedUpdatedAt: "2026-05-02T00:00:00.000Z",
    });
    expect(result).toEqual({ ok: false, code: "stale_write" });
  });
});
