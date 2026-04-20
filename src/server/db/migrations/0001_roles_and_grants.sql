-- Roles and grants. Hand-written because drizzle-kit does not emit DDL for roles,
-- grants, or RLS policies.
--
-- Three runtime roles:
--   app_migrator        — owns the tables; runs migrations; implicitly bypasses RLS
--                         as the owner (but see FORCE ROW LEVEL SECURITY below).
--   app_user            — the app's main runtime role. Subject to RLS.
--   app_tenant_lookup   — read-only, SELECT on a narrow column set of `tenants`.
--                         Used ONLY by the tenant-resolution middleware before
--                         `app.tenant_id` is known.
--   app_platform        — reserved for platform-scope code paths (tenant creation,
--                         future super-admin). Not used in Phase 0. Role + grant
--                         + audit insert policy defined now so the policy surface
--                         is complete; no pool currently opens as app_platform.

-- We use DO blocks so the migration is idempotent in dev. Passwords are set via
-- PG commands outside this migration (Coolify env secrets in staging/prod; dev
-- uses `postgres` superuser to connect and does not authenticate as these roles
-- directly in Phase 0 — the migrator is `postgres` while roles exist for policy
-- targeting. Phase 1 switches the runtime pools to authenticate as these roles.)

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_tenant_lookup') THEN
    CREATE ROLE app_tenant_lookup NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_platform') THEN
    CREATE ROLE app_platform NOLOGIN;
  END IF;
END $$;

-- Usage on schema public for all runtime roles.
GRANT USAGE ON SCHEMA public TO app_user, app_tenant_lookup, app_platform;

-- app_user: CRUD on tenant-scoped tables and Better Auth tables. NO privileges
-- on audit_log or audit_payloads updates/deletes — those are append-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, memberships, access_tokens,
  categories, products, product_options, product_option_values, product_variants,
  addresses, carts, cart_items, orders, order_items,
  redirects,
  tenant_keys, identity_verifications,
  "user", "session", "account", "verification"
TO app_user;

-- audit_log: app_user can SELECT (to display) and INSERT (to write own audit).
-- UPDATE/DELETE/TRUNCATE blocked by policy + trigger + revoke below.
GRANT SELECT, INSERT ON audit_log TO app_user;

-- audit_payloads: app_user can SELECT and INSERT. DELETE allowed for the PDPL
-- scrub path (which also writes a tombstone row into audit_log).
GRANT SELECT, INSERT, DELETE ON audit_payloads TO app_user;

-- Sequence usage: drizzle-kit uses uuid pks with gen_random_uuid(), so no
-- sequences for pks. Timestamps use defaults. Grant on any future sequences
-- would go here.

-- app_tenant_lookup: SELECT on a narrow column set of tenants, nothing else.
GRANT SELECT (id, slug, primary_domain, default_locale, status) ON tenants TO app_tenant_lookup;

-- app_platform: platform-level audit writes (tenant_id IS NULL). Reserved.
GRANT INSERT ON audit_log TO app_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO app_platform;

-- Explicitly revoke TRUNCATE on audit_log from PUBLIC (belt and braces with the
-- BEFORE TRUNCATE trigger in 0003).
REVOKE TRUNCATE ON audit_log FROM PUBLIC;
