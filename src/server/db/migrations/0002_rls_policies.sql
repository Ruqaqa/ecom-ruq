-- Row-level security policies.
--
-- Pattern: every tenant-scoped table has RLS ENABLED and FORCED (applies to
-- table owner as well), with USING and WITH CHECK clauses comparing
-- `tenant_id` to `nullif(current_setting('app.tenant_id', true), '')::uuid`.
--
-- The `, true` second arg to current_setting returns NULL when the GUC is
-- unset; nullif('', ...) then makes an empty string fail-closed too. The
-- ::uuid cast raises on bad input so any query that would depend on the
-- GUC fails closed (zero rows for SELECT, error for write).
--
-- `withTenant(db, tenantId, fn)` in src/server/db/index.ts is the ONLY caller
-- that sets `app.tenant_id`. It uses SET LOCAL (transaction-scoped) and will
-- never SET session-wide. See the code comment on withTenant for why.

-- ============================================================================
-- tenants — self-read only for app_user; narrow-column read for the resolver
-- role (grant is in 0001).
-- ============================================================================
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_self_read ON tenants
  FOR SELECT TO app_user
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_self_update ON tenants
  FOR UPDATE TO app_user
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Resolver role: SELECT on active tenants only, narrow columns enforced by grant.
CREATE POLICY tenant_resolver_read ON tenants
  FOR SELECT TO app_tenant_lookup
  USING (status = 'active');

-- Platform role: full access (reserved for super-admin; not used in Phase 0).
CREATE POLICY tenant_platform_all ON tenants
  FOR ALL TO app_platform
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- Tenant-scoped tables with identical same-tenant scoping for app_user.
-- ============================================================================
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_same_tenant ON memberships
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY access_tokens_same_tenant ON access_tokens
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_keys_same_tenant ON tenant_keys
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE identity_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_verifications_same_tenant ON identity_verifications
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
CREATE POLICY categories_same_tenant ON categories
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY products_same_tenant ON products
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE product_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_options FORCE ROW LEVEL SECURITY;
CREATE POLICY product_options_same_tenant ON product_options
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE product_option_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_option_values FORCE ROW LEVEL SECURITY;
CREATE POLICY product_option_values_same_tenant ON product_option_values
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants FORCE ROW LEVEL SECURITY;
CREATE POLICY product_variants_same_tenant ON product_variants
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY addresses_same_tenant ON addresses
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts FORCE ROW LEVEL SECURITY;
CREATE POLICY carts_same_tenant ON carts
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items FORCE ROW LEVEL SECURITY;
CREATE POLICY cart_items_same_tenant ON cart_items
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_same_tenant ON orders
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY order_items_same_tenant ON order_items
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE redirects FORCE ROW LEVEL SECURITY;
CREATE POLICY redirects_same_tenant ON redirects
  FOR ALL TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================================
-- audit_log: SELECT scoped by tenant; INSERT scoped per-role.
--   app_user writes audit rows only for the current tenant (WITH CHECK matches
--   GUC). There is NO tenant_id IS NULL branch on app_user's WITH CHECK.
--   app_platform writes platform-scope audit rows (tenant_id IS NULL). Not used
--   in Phase 0; reserved.
-- UPDATE/DELETE/TRUNCATE are blocked by triggers in 0003 and by revoke in 0001.
-- ============================================================================
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_select_app_user ON audit_log
  FOR SELECT TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY audit_insert_app_user ON audit_log
  FOR INSERT TO app_user
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY audit_insert_app_platform ON audit_log
  FOR INSERT TO app_platform
  WITH CHECK (tenant_id IS NULL);

-- ============================================================================
-- audit_payloads. Tenant-scoped. Split into explicit SELECT + INSERT policies
-- instead of FOR ALL — app_user has no direct UPDATE grant and no direct
-- DELETE grant (DELETE is revoked in migrations/0004 and deletion routes
-- through the SECURITY DEFINER pdpl_scrub_audit_payloads function). An
-- explicit split means a future grant widening cannot silently enable an
-- unintended action.
-- ============================================================================
ALTER TABLE audit_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_payloads FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_payloads_select_app_user ON audit_payloads
  FOR SELECT TO app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY audit_payloads_insert_app_user ON audit_payloads
  FOR INSERT TO app_user
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- No UPDATE or DELETE policies for app_user: by policy omission combined
-- with the explicit REVOKE in 0004, both fail with permission denied.
