/**
 * Chunk 1a.7.1 Block 5b — POST /api/admin/images/upload route handler tests.
 *
 * Coverage:
 *   - 413 oversized body via Content-Length pre-check (no parse on the
 *     413 path — defense against multi-MB malformed bodies).
 *   - 403 anonymous reject (no session, no bearer).
 *   - 403 customer-role reject (session w/ no membership).
 *   - 400 missing `image` file part.
 *   - 400 missing/invalid `metadata` JSON.
 *   - 200 happy path (real 1500x1500 JPEG via multipart form).
 *   - 409 duplicate fingerprint with `existingImageId` echoed.
 *   - 400 image_too_small for an undersized JPEG.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { __setSessionProviderForTests } from "@/server/auth/resolve-request-identity";
import { __setStorageAdapterForTests } from "@/server/storage";
import { makeJpeg } from "../services/images/_fixtures";

beforeAll(() => {
  const env = process.env as Record<string, string | undefined>;
  if (!env.HASH_PEPPER) env.HASH_PEPPER = randomBytes(32).toString("base64");
});

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const client = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(client, { schema });

afterAll(async () => {
  await client.end({ timeout: 5 });
  __setSessionProviderForTests(null);
  __setStorageAdapterForTests(null);
});

interface InMemoryAdapter {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(): Promise<{ bytes: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
  puts: Array<{ key: string; bytes: Buffer; contentType: string }>;
  deletes: string[];
}

function makeAdapter(): InMemoryAdapter {
  const a: InMemoryAdapter = {
    puts: [],
    deletes: [],
    async put(key, bytes, contentType) {
      this.puts.push({ key, bytes, contentType });
    },
    async get() {
      return null;
    },
    async delete(key) {
      this.deletes.push(key);
    },
  };
  return a;
}

beforeEach(() => {
  __setSessionProviderForTests(null);
  __setStorageAdapterForTests(null);
});

interface TenantFixture {
  tenantId: string;
  host: string;
  slug: string;
}

async function makeTenant(): Promise<TenantFixture> {
  const id = randomUUID();
  const slug = `imgrt-${id.slice(0, 8)}`;
  const host = `${slug}.local`;
  await db.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${host}, 'en', ${"no-reply@" + host},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" })}'::jsonb`)}, 'active')
  `);
  return { tenantId: id, host, slug };
}

async function makeUserAndMembership(
  tenantId: string,
  role: "owner" | "staff" | "support",
): Promise<{ userId: string }> {
  const userId = randomUUID();
  await db.execute(sql`
    INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
    VALUES (${userId}, ${`u-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
  `);
  await db.execute(sql`
    INSERT INTO memberships (id, tenant_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${tenantId}::uuid, ${userId}::uuid, ${role}, now())
  `);
  return { userId };
}

async function seedProduct(tenantId: string): Promise<{
  id: string;
  slug: string;
  updatedAt: string;
}> {
  const id = randomUUID();
  const slug = `p-${id.slice(0, 8)}`;
  const rows = await db.execute<{ updated_at: string }>(sql`
    INSERT INTO products (id, tenant_id, slug, name, status)
    VALUES (${id}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)}, 'draft')
    RETURNING updated_at::text AS updated_at
  `);
  const arr = Array.isArray(rows)
    ? rows
    : (rows as { rows?: Array<{ updated_at: string }> }).rows ?? [];
  return { id, slug, updatedAt: new Date(arr[0]!.updated_at).toISOString() };
}

function buildRequest(args: {
  fixture: TenantFixture;
  contentLength?: string;
  body?: BodyInit;
  headers?: Record<string, string>;
}): Request {
  const headers: Record<string, string> = {
    host: args.fixture.host,
    ...(args.headers ?? {}),
  };
  if (args.contentLength) {
    headers["content-length"] = args.contentLength;
  }
  return new Request(`http://${args.fixture.host}/api/admin/images/upload`, {
    method: "POST",
    headers,
    ...(args.body !== undefined ? { body: args.body } : {}),
  });
}

function setSession(userId: string) {
  __setSessionProviderForTests(async () => ({
    session: { id: "s_" + userId, userId },
    user: { id: userId },
  }));
}

describe("POST /api/admin/images/upload — route handler", () => {
  it("returns 413 on Content-Length > 15 MB without parsing the body", async () => {
    const fx = await makeTenant();
    const { POST } = await import("@/app/api/admin/images/upload/route");
    const req = buildRequest({
      fixture: fx,
      contentLength: String(20 * 1024 * 1024),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("image_too_large");
  });

  it("returns 403 forbidden for an anonymous caller", async () => {
    const fx = await makeTenant();
    __setSessionProviderForTests(async () => null);
    const { POST } = await import("@/app/api/admin/images/upload/route");
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(10)]), "x.jpg");
    fd.append("metadata", JSON.stringify({ productId: randomUUID(), expectedUpdatedAt: new Date().toISOString() }));
    const req = buildRequest({ fixture: fx, body: fd });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 403 forbidden for a customer-role session (no membership row)", async () => {
    const fx = await makeTenant();
    const userId = randomUUID();
    await db.execute(sql`
      INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
      VALUES (${userId}, ${`u-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
    `);
    setSession(userId);
    const { POST } = await import("@/app/api/admin/images/upload/route");
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(10)]), "x.jpg");
    fd.append("metadata", JSON.stringify({ productId: randomUUID(), expectedUpdatedAt: new Date().toISOString() }));
    const req = buildRequest({ fixture: fx, body: fd });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 400 validation_failed when the multipart body has no `image` file part", async () => {
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    setSession(userId);
    const { POST } = await import("@/app/api/admin/images/upload/route");
    const fd = new FormData();
    fd.append("metadata", JSON.stringify({ productId: randomUUID(), expectedUpdatedAt: new Date().toISOString() }));
    const req = buildRequest({ fixture: fx, body: fd });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  it("returns 400 validation_failed when metadata JSON is malformed", async () => {
    const fx = await makeTenant();
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    setSession(userId);
    const { POST } = await import("@/app/api/admin/images/upload/route");
    const jpeg = await makeJpeg(1500, 1500);
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "x.jpg");
    fd.append("metadata", "{not valid json");
    const req = buildRequest({ fixture: fx, body: fd });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  it("returns 200 + image envelope on a happy 1500x1500 JPEG upload", async () => {
    const fx = await makeTenant();
    const product = await seedProduct(fx.tenantId);
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    setSession(userId);
    const adapter = makeAdapter();
    __setStorageAdapterForTests(adapter);

    const { POST } = await import("@/app/api/admin/images/upload/route");
    const jpeg = await makeJpeg(1500, 1500);
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "x.jpg");
    fd.append(
      "metadata",
      JSON.stringify({
        productId: product.id,
        expectedUpdatedAt: product.updatedAt,
      }),
    );
    const req = buildRequest({ fixture: fx, body: fd });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      image: {
        id: string;
        version: number;
        derivatives: Array<unknown>;
        storageKey: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.image.version).toBe(1);
    expect(body.image.derivatives).toHaveLength(15);
    expect(adapter.puts).toHaveLength(16);
  });

  it("returns 409 image_duplicate_in_product with existingImageId on a duplicate fingerprint", async () => {
    const fx = await makeTenant();
    const product = await seedProduct(fx.tenantId);
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    setSession(userId);
    const adapter = makeAdapter();
    __setStorageAdapterForTests(adapter);

    const { POST } = await import("@/app/api/admin/images/upload/route");
    const jpeg = await makeJpeg(1500, 1500);

    // First upload — succeeds.
    const fd1 = new FormData();
    fd1.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "x.jpg");
    fd1.append(
      "metadata",
      JSON.stringify({
        productId: product.id,
        expectedUpdatedAt: product.updatedAt,
      }),
    );
    const r1 = await POST(buildRequest({ fixture: fx, body: fd1 }));
    expect(r1.status).toBe(200);
    const r1Body = (await r1.json()) as { image: { id: string } };

    // Second upload — same bytes, expect 409 with the first image's id echoed.
    const productAfter = await db.execute<{ updated_at: string }>(sql`
      SELECT updated_at::text AS updated_at FROM products WHERE id = ${product.id}
    `);
    const arr = Array.isArray(productAfter)
      ? productAfter
      : (productAfter as { rows?: Array<{ updated_at: string }> }).rows ?? [];
    const newUpdatedAt = new Date(arr[0]!.updated_at).toISOString();
    const fd2 = new FormData();
    fd2.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "x.jpg");
    fd2.append(
      "metadata",
      JSON.stringify({
        productId: product.id,
        expectedUpdatedAt: newUpdatedAt,
      }),
    );
    const r2 = await POST(buildRequest({ fixture: fx, body: fd2 }));
    expect(r2.status).toBe(409);
    const r2Body = (await r2.json()) as {
      error: { code: string };
      existingImageId?: string;
    };
    expect(r2Body.error.code).toBe("image_duplicate_in_product");
    expect(r2Body.existingImageId).toBe(r1Body.image.id);
  });

  it("returns 400 image_too_small for an under-1000px image", async () => {
    const fx = await makeTenant();
    const product = await seedProduct(fx.tenantId);
    const { userId } = await makeUserAndMembership(fx.tenantId, "owner");
    setSession(userId);
    const adapter = makeAdapter();
    __setStorageAdapterForTests(adapter);

    const { POST } = await import("@/app/api/admin/images/upload/route");
    const tiny = await makeJpeg(300, 200);
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(tiny)], { type: "image/jpeg" }), "x.jpg");
    fd.append(
      "metadata",
      JSON.stringify({
        productId: product.id,
        expectedUpdatedAt: product.updatedAt,
      }),
    );
    const res = await POST(buildRequest({ fixture: fx, body: fd }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("image_too_small");
  });
});
