-- Chunk 1a.4.1 — categories foundation.
--
-- Pre-launch local-only DB. Destructive on slug shape, intentional, not
-- reversible. Owner explicitly chose Latin URLs over Arabic-script URLs
-- for share-ability — bilingual `name`/`description` still apply at the
-- JSONB column level.
--
-- Same drop-then-reshape pattern as 0007_slug_single_latin.sql for products:
-- there are no real category rows yet, so a clean break is preferable to
-- a multi-step migration.
--
-- Drops the products.category_id 1:N column entirely. Many-to-many lives
-- in the new product_categories join table. No back-fill — pre-launch DB.

DELETE FROM categories;

ALTER TABLE categories DROP COLUMN slug;
ALTER TABLE categories ADD COLUMN slug text NOT NULL;

-- Slug uniqueness within tenant among non-soft-deleted rows. The partial
-- index lets a soft-deleted row keep its slug without blocking a new
-- live row that wants to reuse it. Collisions throw pg 23505;
-- extractPgUniqueViolation maps it to SlugTakenError.
CREATE UNIQUE INDEX categories_tenant_slug_unique_live
  ON categories (tenant_id, slug)
  WHERE deleted_at IS NULL;

-- Drop the old 1:N pointer + its index. M:N replaces it.
DROP INDEX IF EXISTS products_category_id_idx;
ALTER TABLE products DROP COLUMN category_id;

-- M:N join table. Composite PK on (product_id, category_id) prevents
-- duplicate links. `tenant_id` is denormalized so the RLS policy can
-- gate it independently of the parent rows; both parents already enforce
-- tenant isolation, but the join row carries it for grep-able policy
-- consistency with every other tenant-scoped table.
CREATE TABLE product_categories (
  tenant_id   uuid NOT NULL REFERENCES tenants(id)    ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id)   ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, category_id)
);

-- Reverse-lookup index for "which products are in this category".
CREATE INDEX product_categories_category_idx
  ON product_categories (category_id, product_id);
CREATE INDEX product_categories_tenant_idx
  ON product_categories (tenant_id);

ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY product_categories_same_tenant ON product_categories
  FOR ALL TO app_user
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON product_categories TO app_user;
