#!/usr/bin/env tsx
/**
 * Idempotent dev-tenant seeder.
 *
 * Creates / upserts a single tenant row for `localhost:5001` so the
 * Playwright suite, the dev server, and ad-hoc curls all resolve to a
 * real tenant rather than the dev-fallback stub. Runs on every
 * `pnpm db:seed:dev` and inside `tests/e2e/global-setup.ts` so CI is
 * deterministic.
 *
 * Idempotence: `ON CONFLICT (primary_domain) DO UPDATE` on the columns
 * we actually want to keep fresh. `slug` is unique independently; we
 * match on primary_domain since that's the resolver's lookup key.
 */
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:55432/ecom_ruq_dev";
const HOST = "localhost:5001";
const SLUG = "ruqaqa-local";
const NAME = { en: "Ruqaqa (local)", ar: "رقاقة (محلي)" };
const SENDER_EMAIL = "no-reply@localhost";

export async function seedDevTenant(): Promise<{ id: string }> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO tenants (slug, primary_domain, default_locale, status, name, sender_email)
      VALUES (${SLUG}, ${HOST}, 'ar', 'active', ${sql.json(NAME)}, ${SENDER_EMAIL})
      ON CONFLICT (primary_domain) DO UPDATE
        SET slug = EXCLUDED.slug,
            default_locale = EXCLUDED.default_locale,
            status = EXCLUDED.status,
            name = EXCLUDED.name,
            sender_email = EXCLUDED.sender_email,
            updated_at = now()
      RETURNING id
    `;
    const first = rows[0];
    if (!first) throw new Error("seed-dev-tenant: INSERT returned no rows");
    return { id: first.id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const runFromCli =
  process.argv[1]?.endsWith("seed-dev-tenant.ts") ||
  process.argv[1]?.endsWith("seed-dev-tenant.js");

if (runFromCli) {
  seedDevTenant()
    .then(({ id }) => {
      console.log(`Seeded dev tenant for ${HOST} (id ${id})`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
