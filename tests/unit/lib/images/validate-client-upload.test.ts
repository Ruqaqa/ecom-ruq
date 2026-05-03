/**
 * `validateClientUpload` — pre-upload client validator (chunk 1a.7.2
 * Block 3c). Pure: only file size + MIME type / extension fallback.
 */
import { describe, expect, it, vi } from "vitest";
import { validateClientUpload } from "@/lib/images/validate-client-upload";

function makeFile(opts: {
  name: string;
  type: string;
  size: number;
}): File {
  // Wrap a Uint8Array so File.size matches without allocating a giant
  // buffer. Browsers infer size from the blob parts.
  const blob = new Blob([new Uint8Array(opts.size)], { type: opts.type });
  return new File([blob], opts.name, { type: opts.type });
}

describe("validateClientUpload", () => {
  it("accepts a 5MB JPEG", () => {
    const file = makeFile({
      name: "photo.jpg",
      type: "image/jpeg",
      size: 5 * 1024 * 1024,
    });
    expect(validateClientUpload(file)).toEqual({ ok: true });
  });

  it("rejects an 11MB JPEG with too_large", () => {
    const file = makeFile({
      name: "photo.jpg",
      type: "image/jpeg",
      size: 11 * 1024 * 1024,
    });
    expect(validateClientUpload(file)).toEqual({
      ok: false,
      code: "too_large",
    });
  });

  it("rejects text/plain with unsupported_format", () => {
    const file = makeFile({ name: "notes.txt", type: "text/plain", size: 100 });
    expect(validateClientUpload(file)).toEqual({
      ok: false,
      code: "unsupported_format",
    });
  });

  it("accepts a file with empty type but .jpg extension (iOS share fallback)", () => {
    const file = makeFile({ name: "IMG_0001.jpg", type: "", size: 1024 });
    expect(validateClientUpload(file)).toEqual({ ok: true });
  });

  it("accepts a file with empty type but .jpeg extension", () => {
    const file = makeFile({ name: "IMG_0002.JPEG", type: "", size: 1024 });
    expect(validateClientUpload(file)).toEqual({ ok: true });
  });

  it("rejects a file with empty type and .gif extension", () => {
    const file = makeFile({ name: "anim.gif", type: "", size: 1024 });
    expect(validateClientUpload(file)).toEqual({
      ok: false,
      code: "unsupported_format",
    });
  });

  it("never invokes new Image() (pure validator, no decode)", () => {
    const ImageSpy = vi.fn();
    const original = (globalThis as { Image?: unknown }).Image;
    (globalThis as { Image?: unknown }).Image = ImageSpy;
    try {
      const file = makeFile({
        name: "x.png",
        type: "image/png",
        size: 1024,
      });
      validateClientUpload(file);
      expect(ImageSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as { Image?: unknown }).Image = original;
    }
  });
});
