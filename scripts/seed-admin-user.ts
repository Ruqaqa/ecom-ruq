#!/usr/bin/env tsx
/**
 * Idempotent E2E admin+customer user seeder.
 *
 * Creates two fixture accounts in the dev tenant (`localhost:5001`)
 * that Playwright's admin flow depends on:
 *   - `admin-owner@test.local` — owner membership, password known.
 *   - `customer@test.local`    — no membership row (pure customer).
 *
 * Both users are upserted (UPDATE on conflict) so this script is safe
 * to re-run. `tests/e2e/global-setup.ts` invokes it on every suite
 * start after the dev-tenant seed + rate-limit Redis flush.
 *
 * Password hashing uses Better Auth's own `hashPassword` so the rows
 * are indistinguishable from a user that signed up through BA's
 * `/sign-up/email` endpoint. Email is marked verified so Playwright
 * doesn't need to click a Mailpit link to progress.
 */
import postgres from "postgres";
import { randomBytes, randomUUID, scrypt } from "node:crypto";

/**
 * Scrypt parameters matched to Better Auth's default password hasher
 * at @better-auth/utils/password.node — N=16384, r=16, p=1, dkLen=64,
 * 16-byte hex salt, stored as `${salt}:${key}`. Keeping parity so BA's
 * verifyPassword works against rows this seeder writes.
 */
const SCRYPT = { N: 16384, r: 16, p: 1, dkLen: 64 } as const;

function scryptAsync(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      SCRYPT.dkLen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await scryptAsync(password, salt);
  return `${salt}:${key.toString("hex")}`;
}

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";

const DEV_TENANT_HOST = "localhost:5001";

export const OWNER_EMAIL = "admin-owner@test.local";
export const CUSTOMER_EMAIL = "customer@test.local";
// Staff fixture added in sub-chunk 7.5 so the admin PAT-management UI
// can assert the staff-role view (list visible, create/revoke hidden).
export const STAFF_EMAIL = "admin-staff@test.local";
export const FIXTURE_PASSWORD = "CorrectHorseBatteryStaple-9183";

export async function seedAdminUser(): Promise<{
  ownerId: string;
  staffId: string;
  customerId: string;
  tenantId: string;
}> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const tenantRows = await sql<Array<{ id: string }>>`
      SELECT id FROM tenants WHERE primary_domain = ${DEV_TENANT_HOST} LIMIT 1
    `;
    const tenantId = tenantRows[0]?.id;
    if (!tenantId) {
      throw new Error(
        `seed-admin-user: no tenant row for ${DEV_TENANT_HOST}; run seed-dev-tenant first`,
      );
    }

    const passwordHash = await hashPassword(FIXTURE_PASSWORD);

    const ownerId = await upsertUserWithPassword(
      sql,
      OWNER_EMAIL,
      passwordHash,
    );
    const staffId = await upsertUserWithPassword(
      sql,
      STAFF_EMAIL,
      passwordHash,
    );
    const customerId = await upsertUserWithPassword(
      sql,
      CUSTOMER_EMAIL,
      passwordHash,
    );

    // Membership: owner ↔ tenant. Customer intentionally has NO row.
    await sql`
      INSERT INTO memberships (id, tenant_id, user_id, role, created_at)
      VALUES (${randomUUID()}, ${tenantId}::uuid, ${ownerId}::uuid, 'owner', now())
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner'
    `;
    // Staff membership for the read-only-PAT-list coverage (sub-chunk 7.5).
    await sql`
      INSERT INTO memberships (id, tenant_id, user_id, role, created_at)
      VALUES (${randomUUID()}, ${tenantId}::uuid, ${staffId}::uuid, 'staff', now())
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'staff'
    `;

    // Defensive: a prior run that created a customer membership row
    // shouldn't linger. Remove one if it exists. (We don't rely on
    // this in the happy path — the customer row is created below
    // WITHOUT a membership, but stray rows from manual tinkering
    // would break the FORBIDDEN test.)
    await sql`
      DELETE FROM memberships WHERE tenant_id = ${tenantId}::uuid AND user_id = ${customerId}::uuid
    `;

    return { ownerId, staffId, customerId, tenantId };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function upsertUserWithPassword(
  sql: postgres.Sql<Record<string, unknown>>,
  email: string,
  passwordHash: string,
): Promise<string> {
  // BA's schema has NO unique index on `user.email` or on
  // `account.(provider_id, account_id)` — upsert has to be a
  // find-or-create. SELECT under the same tx would be cleaner; we
  // don't wrap in `sql.begin` here because idempotence is by design
  // single-writer (dev + CI seed, no racing peers).
  const existing = await sql<Array<{ id: string }>>`
    SELECT id FROM "user" WHERE email = ${email} LIMIT 1
  `;
  let userId = existing[0]?.id;

  if (!userId) {
    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO "user" (id, email, email_verified, created_at, updated_at)
      VALUES (${randomUUID()}, ${email}, true, now(), now())
      RETURNING id
    `;
    userId = inserted[0]?.id;
  } else {
    await sql`
      UPDATE "user" SET email_verified = true, updated_at = now() WHERE id = ${userId}::uuid
    `;
  }
  if (!userId) throw new Error(`upsertUserWithPassword: no id for ${email}`);

  // BA `account` row carrying the credential. `provider_id =
  // 'credential'` is BA's convention for email+password; `account_id`
  // equals the email.
  const existingAccount = await sql<Array<{ id: string }>>`
    SELECT id FROM account WHERE provider_id = 'credential' AND account_id = ${email} LIMIT 1
  `;
  if (existingAccount[0]?.id) {
    await sql`
      UPDATE account
         SET password = ${passwordHash},
             user_id = ${userId}::uuid,
             updated_at = now()
       WHERE id = ${existingAccount[0].id}::uuid
    `;
  } else {
    await sql`
      INSERT INTO account (id, user_id, account_id, provider_id, password, created_at, updated_at)
      VALUES (${randomUUID()}, ${userId}::uuid, ${email}, 'credential', ${passwordHash}, now(), now())
    `;
  }

  return userId;
}

const runFromCli =
  process.argv[1]?.endsWith("seed-admin-user.ts") ||
  process.argv[1]?.endsWith("seed-admin-user.js");

if (runFromCli) {
  seedAdminUser()
    .then(({ ownerId, staffId, customerId, tenantId }) => {
      console.log(
        `Seeded admin fixtures: owner=${ownerId} staff=${staffId} customer=${customerId} tenant=${tenantId}`,
      );
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
