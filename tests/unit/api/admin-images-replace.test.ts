/**
 * Chunk 1a.7.1 Block 5b — POST /api/admin/images/replace route handler tests.
 *
 * Coverage parallel to the upload route, plus the confirm:true gate.
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
  const slug = `imgrp-${id.slice(0, 8)}`;
  const host = `${slug}.local`;
  await db.execute(sql`
    INSERT INTO tenants (id, slug, primary_domain, default_locale, sender_email, name, status)
    VALUES (${id}, ${slug}, ${host}, 'en', ${"no-reply@" + host},
      ${sql.raw(`'${JSON.stringify({ en: "T", ar: "ت" })}'::jsonb`)}, 'active')
  `);
  return { tenantId: id, host, slug };
}

async function makeOwner(tenantId: string): Promise<string> {
  const userId = randomUUID();
  await db.execute(sql`
    INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
    VALUES (${userId}, ${`u-${userId.slice(0, 8)}@ex.test`}, true, now(), now())
  `);
  await db.execute(sql`
    INSERT INTO memberships (id, tenant_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${tenantId}::uuid, ${userId}::uuid, 'owner', now())
  `);
  return userId;
}

async function seedProductWithImage(
  tenantId: string,
): Promise<{ productId: string; productUpdatedAt: string; imageId: string }> {
  const productId = randomUUID();
  const slug = `p-${productId.slice(0, 8)}`;
  const productRows = await db.execute<{ updated_at: string }>(sql`
    INSERT INTO products (id, tenant_id, slug, name, status)
    VALUES (${productId}, ${tenantId}, ${slug},
      ${sql.raw(`'${JSON.stringify({ en: "P", ar: "م" })}'::jsonb`)}, 'draft')
    RETURNING updated_at::text AS updated_at
  `);
  const arr = Array.isArray(productRows)
    ? productRows
    : (productRows as { rows?: Array<{ updated_at: string }> }).rows ?? [];
  const productUpdatedAt = new Date(arr[0]!.updated_at).toISOString();
  const imageId = randomUUID();
  await db.execute(sql`
    INSERT INTO product_images (
      id, tenant_id, product_id, position, version, fingerprint_sha256,
      storage_key, original_format, original_width, original_height,
      original_bytes
    ) VALUES (
      ${imageId}, ${tenantId}, ${productId}, 0, 1, ${"a".repeat(64)},
      'k-orig-v1', 'jpeg', 1500, 1500, 1234
    )
  `);
  return { productId, productUpdatedAt, imageId };
}

function buildRequest(args: {
  fixture: TenantFixture;
  contentLength?: string;
  body?: BodyInit;
}): Request {
  const headers: Record<string, string> = { host: args.fixture.host };
  if (args.contentLength) headers["content-length"] = args.contentLength;
  return new Request(`http://${args.fixture.host}/api/admin/images/replace`, {
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

describe("POST /api/admin/images/replace — route handler", () => {
  it("returns 200 with bumped version on a happy replace", async () => {
    const fx = await makeTenant();
    const userId = await makeOwner(fx.tenantId);
    const { productUpdatedAt, imageId } = await seedProductWithImage(
      fx.tenantId,
    );
    setSession(userId);
    const adapter = makeAdapter();
    __setStorageAdapterForTests(adapter);

    const { POST } = await import("@/app/api/admin/images/replace/route");
    const jpeg = await makeJpeg(1400, 1400);
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "x.jpg");
    fd.append(
      "metadata",
      JSON.stringify({
        imageId,
        expectedUpdatedAt: productUpdatedAt,
        confirm: true,
      }),
    );
    const res = await POST(buildRequest({ fixture: fx, body: fd }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      image: { id: string; version: number; storageKey: string };
    };
    expect(body.image.version).toBe(2);
    expect(body.image.storageKey).toMatch(/-v2-original\.jpg$/);
  });

  it("returns 400 validation_failed when confirm is missing", async () => {
    const fx = await makeTenant();
    const userId = await makeOwner(fx.tenantId);
    const { productUpdatedAt, imageId } = await seedProductWithImage(
      fx.tenantId,
    );
    setSession(userId);

    const { POST } = await import("@/app/api/admin/images/replace/route");
    const jpeg = await makeJpeg(1400, 1400);
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "x.jpg");
    fd.append(
      "metadata",
      JSON.stringify({
        imageId,
        expectedUpdatedAt: productUpdatedAt,
        // missing confirm:true
      }),
    );
    const res = await POST(buildRequest({ fixture: fx, body: fd }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  it("returns 403 for an anonymous caller", async () => {
    const fx = await makeTenant();
    __setSessionProviderForTests(async () => null);

    const { POST } = await import("@/app/api/admin/images/replace/route");
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(10)]), "x.jpg");
    fd.append(
      "metadata",
      JSON.stringify({
        imageId: randomUUID(),
        expectedUpdatedAt: new Date().toISOString(),
        confirm: true,
      }),
    );
    const res = await POST(buildRequest({ fixture: fx, body: fd }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 413 on Content-Length > 15 MB", async () => {
    const fx = await makeTenant();
    const { POST } = await import("@/app/api/admin/images/replace/route");
    const res = await POST(
      buildRequest({
        fixture: fx,
        contentLength: String(20 * 1024 * 1024),
      }),
    );
    expect(res.status).toBe(413);
  });
});
