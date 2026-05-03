/**
 * Playwright global setup: seed dev tenant + clear Mailpit + clear
 * auth rate-limit buckets.
 *
 * Runs once before the whole test run. Ensures:
 *   - a real tenant row exists for `localhost:5001` (so the DB-backed
 *     resolver returns it; no dependence on ALLOW_TENANT_FALLBACK);
 *   - Mailpit is empty so email-assertion tests do not trip over stale
 *     messages from a previous run;
 *   - rate-limit Redis keys for the auth bucket prefix are dropped so
 *     Playwright's parallel auth tests don't accumulate hits against the
 *     per-IP limit (dev has no proxy so every caller resolves to
 *     `unknown-ip` and shares one bucket per endpoint);
 *   - dev-tenant catalog rows seeded by prior e2e runs (slug-prefixed
 *     `e2e-`) are deleted. Categories have no pagination by design (the
 *     depth-3 cap caps a real tenant at a few hundred), so accumulated
 *     test rows make `/admin/categories` and the picker render thousands
 *     of <li>s. WebKit's axe-core walk is O(n²)-ish on that DOM and
 *     `axe.runPartial` times out — Chromium's faster, so the failure is
 *     iPhone-only. Sweeping the prefix on setup keeps the page small
 *     enough for axe on every project. Manually-seeded operator data
 *     (any slug not starting with `e2e-`) is preserved.
 *
 * We intentionally do NOT truncate auth tables. Between-run isolation is
 * handled by per-test random emails; chunk 8 adds the full test-data
 * harness with per-worker tenant suffixes.
 */
import { request as playwrightRequest } from "@playwright/test";
import Redis from "ioredis";
import postgres from "postgres";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { seedDevTenant } from "../../scripts/seed-dev-tenant";
import { seedAdminUser } from "../../scripts/seed-admin-user";
import { TEST_TOKEN_PREFIX } from "./helpers/test-token-name";

export default async function globalSetup(): Promise<void> {
  const { id: devTenantId } = await seedDevTenant();
  await seedAdminUser();

  // Sweep access_tokens named with the shared test-prefix in the dev
  // tenant. Prior runs crash-exit, are Ctrl-C'd, or simply do not clean
  // up after themselves — the rows accumulate and pollute
  // /{locale}/admin/tokens for the human operator. Manually-minted
  // tokens (e.g. the one powering Claude Desktop) deliberately do NOT
  // use this prefix and survive the sweep. See
  // tests/e2e/helpers/test-token-name.ts for the prefix contract.
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      DELETE FROM access_tokens
      WHERE tenant_id = ${devTenantId}
        AND name LIKE ${TEST_TOKEN_PREFIX + "%"}
    `;
    // Sweep e2e-prefixed catalog rows. Specs across many runs leave
    // products + categories behind; categories has no pagination, so the
    // /admin/categories list and the picker can balloon to thousands of
    // rows. WebKit's axe-core then times out (Chromium is faster, so the
    // failure is iPhone-only). The category self-FK + product_categories
    // FKs are ON DELETE CASCADE, so deleting categories alone is enough
    // to clean up the whole tree and any cross-links; products are
    // independent and need their own sweep. Both deletes are scoped to
    // the dev tenant AND restricted to slugs that begin with `e2e-`, so
    // operator-seeded data (any other slug shape) survives.
    await sql`
      DELETE FROM products
      WHERE tenant_id = ${devTenantId}
        AND slug LIKE 'e2e-%'
    `;
    await sql`
      DELETE FROM categories
      WHERE tenant_id = ${devTenantId}
        AND slug LIKE 'e2e-%'
    `;
    // Sweep product_images that belong to e2e-prefixed products. The
    // FK is ON DELETE CASCADE so the products sweep above already takes
    // these out, but rows can stick around if a prior crash left an
    // orphan; this is idempotent belt-and-braces.
    await sql`
      DELETE FROM product_images
      WHERE tenant_id = ${devTenantId}
        AND product_id NOT IN (SELECT id FROM products WHERE tenant_id = ${devTenantId})
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }

  // Sweep local-disk storage for image bytes so adapter.get returns
  // null for any orphaned keys from prior runs. Best-effort — if the
  // dir doesn't exist, ignore.
  try {
    await rm(".storage/images", { recursive: true, force: true });
  } catch {
    // ignore
  }

  // Generate image fixtures used by the photos admin spec. All real
  // JPEGs (Sharp-decodable). Idempotent: the writeFile pass overwrites
  // any partial files from a crashed prior run.
  await ensureImageFixtures();

  const mailpitBase = process.env.MAILPIT_URL ?? "http://localhost:58025";
  const ctx = await playwrightRequest.newContext({ baseURL: mailpitBase });
  try {
    await ctx.delete("/api/v1/messages").catch(() => {
      // If Mailpit isn't reachable, the email-flow tests will surface the
      // problem explicitly. Don't fail setup for an uncritical clear.
    });
  } finally {
    await ctx.dispose();
  }

  // Clear rate-limit buckets. Best-effort — if Redis is down, the auth
  // tests will throw SERVICE_UNAVAILABLE which surfaces the real issue.
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:56379";
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    // SCAN + DEL all ratelimit:auth:* keys. We scope to the auth prefix
    // so ad-hoc non-auth rate limiters (if any) don't get flushed.
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "ratelimit:auth:*", "COUNT", 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
    // Also flush the PAT issuance bucket. Sub-chunk 7.5 Playwright
    // tests mint many PATs in parallel against the single dev tenant;
    // the 20/hour rate limit is plenty for a human operator but not
    // for a suite that spins up 4+ workers × multiple mint flows.
    let ptCursor = "0";
    do {
      const [next, keys] = await redis.scan(
        ptCursor,
        "MATCH",
        "ratelimit:pat:issuance:*",
        "COUNT",
        500,
      );
      ptCursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (ptCursor !== "0");
  } catch {
    // Swallow — Redis unavailable means auth tests will fail loudly.
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

const FIXTURES_DIR = join("tests", "e2e", "fixtures", "images");

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function makeJpegFixture(
  path: string,
  opts: {
    width: number;
    height: number;
    rgb: { r: number; g: number; b: number };
    quality?: number;
  },
): Promise<void> {
  const buf = await sharp({
    create: {
      width: opts.width,
      height: opts.height,
      channels: 3,
      background: opts.rgb,
    },
  })
    .jpeg({ quality: opts.quality ?? 80 })
    .toBuffer();
  await writeFile(path, buf);
}

async function ensureImageFixtures(): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });

  // Three valid 2000×2000 JPEGs with distinct color fingerprints so
  // duplicate-fingerprint detection separates them.
  await makeJpegFixture(join(FIXTURES_DIR, "valid-2000.jpg"), {
    width: 2000,
    height: 2000,
    rgb: { r: 200, g: 100, b: 50 },
  });
  await makeJpegFixture(join(FIXTURES_DIR, "valid-2000-alt.jpg"), {
    width: 2000,
    height: 2000,
    rgb: { r: 50, g: 200, b: 100 },
  });
  await makeJpegFixture(join(FIXTURES_DIR, "valid-2000-third.jpg"), {
    width: 2000,
    height: 2000,
    rgb: { r: 100, g: 50, b: 200 },
  });

  // 500×500 — passes client validation (size + mime), fails server
  // dimension check with image_too_small.
  await makeJpegFixture(join(FIXTURES_DIR, "too-small-500.jpg"), {
    width: 500,
    height: 500,
    rgb: { r: 30, g: 30, b: 30 },
  });

  // Plain text — fails client mime/extension validation.
  const txtPath = join(FIXTURES_DIR, "not-an-image.txt");
  if (!(await fileExists(txtPath))) {
    await writeFile(txtPath, "this is not an image\n", "utf8");
  }

  // 12 MB JPEG. We start from a small valid JPEG header and append pad
  // bytes after EOI — Sharp ignores trailing bytes but file.size grows.
  // Generated only if not already present (it's 12 MB and we don't want
  // to rewrite it on every run).
  const bigPath = join(FIXTURES_DIR, "too-large-12mb.jpg");
  if (!(await fileExists(bigPath))) {
    const seed = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .jpeg({ quality: 70 })
      .toBuffer();
    const padSize = 12 * 1024 * 1024 - seed.length + 1024;
    const pad = Buffer.alloc(padSize, 0);
    await writeFile(bigPath, Buffer.concat([seed, pad]));
  }
}
