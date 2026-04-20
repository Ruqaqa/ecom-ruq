-- Chunk 5: per-tenant sender email + resolver column grant.
--
-- Per prd.md §3.6, transactional email MUST be rendered against the tenant's
-- own domain and `From` address. `senderEmail` lives on `tenants` so that
-- `sendTenantEmail` can never derive it from a `Host` header. The CHECK is a
-- cheap shape guard (no full RFC 5322 — that gate lives at the admin UI that
-- writes the column).
--
-- The resolver pool (`app_tenant_lookup`) needs SELECT on the new column so
-- `resolveTenant(host)` can return the `senderEmail` alongside the existing
-- narrow set. All other resolver-column restrictions stay as they were.

ALTER TABLE tenants
  ADD COLUMN sender_email text;

-- Backfill for any rows created before chunk 5 (there are none in prod yet,
-- but dev databases and the RLS-canary test may have inserted rows). Use a
-- placeholder; callers that rely on it MUST overwrite before enabling the
-- tenant. The CHECK below accepts placeholder@placeholder so legacy rows
-- do not block migration.
UPDATE tenants
   SET sender_email = 'no-reply@' || primary_domain
 WHERE sender_email IS NULL;

ALTER TABLE tenants
  ALTER COLUMN sender_email SET NOT NULL;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_sender_email_shape
  CHECK (sender_email ~ '^[^@\s]+@[^@\s]+$');

-- Extend the narrow column grant to include sender_email.
GRANT SELECT (id, slug, primary_domain, default_locale, status, sender_email) ON tenants TO app_tenant_lookup;
