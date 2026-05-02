/**
 * Chunk 1a.7.1 Block 3 — fixture builders for processImage tests.
 *
 * All fixtures are constructed in code rather than committed binaries so
 * the test suite stays self-contained and the bomb fixture can be
 * regenerated from this single source.
 */
import sharp from "sharp";
import { createHash } from "node:crypto";

/**
 * Make a real JPEG with controlled dimensions. Uses sharp itself to
 * encode a solid-color buffer.
 */
export async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Make an EXIF-rotated JPEG (orientation = 6, i.e. 90° CW). Constructs
 * the JPEG via sharp then injects an EXIF block. We use `withMetadata`
 * to set orientation here — this is FIXTURE code, not pipeline code.
 */
export async function makeRotatedJpeg(
  width: number,
  height: number,
): Promise<Buffer> {
  // sharp's withMetadata can stamp orientation directly.
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 50, g: 200, b: 100 },
    },
  })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

/**
 * Make a real WebP.
 */
export async function makeWebp(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 100, b: 200 },
    },
  })
    .webp({ quality: 90 })
    .toBuffer();
}

/**
 * Build a PNG header that DECLARES a 100,000 × 100,000 image but
 * contains a near-empty IDAT chunk. Sharp's `metadata()` reads the
 * IHDR for declared width/height — if the pipeline reaches DECODE,
 * limitInputPixels caps it; if our pipeline rejects on declared
 * dimensions before decode, this never allocates 10⁹ pixels.
 *
 * The fixture is a malformed-but-structurally-valid PNG: signature +
 * IHDR (declaring the bomb) + a single empty IDAT + IEND. sharp's
 * metadata() reads the IHDR; the file is well-formed enough for the
 * sniff + metadata probe to fire. A subsequent decode would fail —
 * that's the worst case if our defense fails. But the right behavior is
 * to reject the declared size BEFORE decode.
 */
export function makePngBomb(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR: 13 bytes data — width(4), height(4), bit depth(1), color(1),
  // compression(1), filter(1), interlace(1).
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(100_000, 0); // width
  ihdrData.writeUInt32BE(100_000, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdrChunk = pngChunk("IHDR", ihdrData);
  // Empty IDAT — sharp may or may not actually decode; we want the
  // pre-decode probe to reject before this matters.
  const idatChunk = pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]));
  const iendChunk = pngChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  // CRC over (type + data).
  const crc = crc32(Buffer.concat([typeBuf, data]));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE: number[] = (() => {
  const t: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): Buffer {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  c = (c ^ 0xffffffff) >>> 0;
  const out = Buffer.alloc(4);
  out.writeUInt32BE(c, 0);
  return out;
}

/**
 * A "polyglot" — valid JPEG followed by HTML. Sharp's re-encode strips
 * the trailing data; the test asserts the output bytes don't contain
 * the HTML signature.
 */
export async function makeJpegWithTrailingHtml(): Promise<Buffer> {
  const jpeg = await makeJpeg(1500, 1500);
  return Buffer.concat([
    jpeg,
    Buffer.from("<script>alert('polyglot-payload')</script>", "utf8"),
  ]);
}

/**
 * SVG document. sniffFormat must reject this as image_unsupported_format.
 */
export function makeSvg(): Buffer {
  return Buffer.from(
    `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script></svg>`,
    "utf8",
  );
}

/**
 * Truncated JPEG — first 200 bytes of a real JPEG. Sharp should fail
 * decode with `failOn: 'warning'`.
 */
export async function makeTruncatedJpeg(): Promise<Buffer> {
  const real = await makeJpeg(2000, 2000);
  return real.subarray(0, 200);
}

export function fingerprint(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
