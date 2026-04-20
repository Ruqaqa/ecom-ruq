# Database roles — NOLOGIN in Phase 0, LOGIN flip for staging/prod

Phase 0 creates four Postgres roles in `migrations/0001_roles_and_grants.sql`:

- `app_migrator` — owns the tables; runs migrations.
- `app_user` — runtime pool role; subject to RLS.
- `app_tenant_lookup` — narrow-grant reader for the host→tenant resolver.
- `app_platform` — reserved for super-admin platform writes.

All four are created `NOLOGIN`. The runtime pools in `src/server/db/index.ts`
currently connect as the superuser `postgres`, and the RLS canary tests
target the correct role via `SET LOCAL ROLE <role>` inside the tx. This is
intentional for Phase 0: it keeps dev friction low while the policy surface
and privilege topology are shaping.

## Why the NOLOGIN default is safe for Phase 0

- RLS policies are keyed on **role** (`TO app_user`, `TO app_tenant_lookup`, etc.),
  not on login identity. Policies apply whenever the session's current role is
  that role, whether the role was reached via LOGIN or `SET ROLE`.
- `FORCE ROW LEVEL SECURITY` is on every tenant-scoped table, so even the
  owner (`app_migrator`, or `postgres` as superuser when it executes as owner)
  is subject to policies when the session's role is `app_user`.
- Phase 0 has no external network exposure; the only live clients are the
  developer's laptop and CI.

## The flip for staging/production

Before standing up staging or production, each of the three runtime roles
must be switched to LOGIN with a strong, secrets-managed password:

```sql
ALTER ROLE app_user           LOGIN PASSWORD '<generated>';
ALTER ROLE app_tenant_lookup  LOGIN PASSWORD '<generated>';
ALTER ROLE app_platform       LOGIN PASSWORD '<generated>';
-- app_migrator stays NOLOGIN unless you use a separate migration identity;
-- the migrator is typically invoked via a one-shot CI job that escalates.
```

Rotate generated passwords into the environment's secret store (Coolify for
staging/prod, GitHub Actions secrets for CI). Update the DSN environment
variables:

- `DATABASE_URL_APP` — connects as `app_user`
- `DATABASE_URL_TENANT_LOOKUP` — connects as `app_tenant_lookup`
- `DATABASE_URL` — used by the migrator only; connects as `app_migrator` (or a
  privileged identity that `SET ROLE app_migrator` before running `pnpm db:migrate`)

After the flip, the application stops having superuser access at runtime.
Policies gain teeth (the owner no longer implicitly bypasses RLS because
`app_user` is a distinct login role that never owned the tables). The RLS
canary test harness still uses `postgres` + `SET LOCAL ROLE app_user` to
target policies without needing staging secrets locally.

## What to verify after the flip

1. `DATABASE_URL_APP` opens as `app_user`: `SELECT current_user` returns `app_user`.
2. Any direct SELECT on a tenant-scoped table without `SET LOCAL app.tenant_id`
   returns zero rows (RLS fail-closed).
3. `DATABASE_URL_TENANT_LOOKUP` opens as `app_tenant_lookup`: `SELECT` on the
   narrow-granted `tenants` columns succeeds; `SELECT` on `tenants.name` (or
   any other tenant-scoped table) is rejected with `permission denied`.
4. Migrator pool can CREATE TABLE / CREATE POLICY; runtime pools cannot.

## Rotation

Password rotation follows the same pattern as
`docs/runbooks/kek-rotation.md`: generate a new password, update the DSN
environment variable, deploy, run `ALTER ROLE <role> PASSWORD '<new>'`, retire
the old password. Do this annually and on any suspected compromise.
