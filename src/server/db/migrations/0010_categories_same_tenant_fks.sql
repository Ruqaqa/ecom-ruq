-- Chunk 1a.4.1 follow-up — same-tenant data-layer guarantees.
--
-- Closes a defense-in-depth gap surfaced by the security review of 1a.4.1.
-- Previously, only the application layer prevented (a) a category having
-- a parent in a different tenant and (b) a product_categories row with
-- a tenant_id that disagreed with its product/category. CLAUDE.md §5
-- says RLS is the safety net; this is the matching belt.
--
-- Three changes:
--   1. Add UNIQUE (tenant_id, id) on categories and products so they can
--      be the targets of composite FKs. Redundant for query planning
--      (id alone is PK), required to anchor the composite FK.
--   2. Backfill the missing FK on categories.parent_id as a composite,
--      so a parent must live in the same tenant as the child. Postgres
--      had no FK at all on this column before — even non-existent uuids
--      were accepted. ON DELETE CASCADE matches the tree-cascade
--      semantics planned for chunk 1a.4.3.
--   3. Replace the single-column FKs on product_categories with composite
--      ones so the join row's tenant_id must match both parents.

ALTER TABLE categories
  ADD CONSTRAINT categories_tenant_id_id_unique UNIQUE (tenant_id, id);
ALTER TABLE products
  ADD CONSTRAINT products_tenant_id_id_unique UNIQUE (tenant_id, id);

ALTER TABLE categories
  ADD CONSTRAINT categories_parent_same_tenant_fk
  FOREIGN KEY (tenant_id, parent_id)
  REFERENCES categories (tenant_id, id)
  ON DELETE CASCADE;

ALTER TABLE product_categories
  DROP CONSTRAINT product_categories_product_id_fkey,
  DROP CONSTRAINT product_categories_category_id_fkey;

ALTER TABLE product_categories
  ADD CONSTRAINT product_categories_product_same_tenant_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES products (tenant_id, id)
    ON DELETE CASCADE,
  ADD CONSTRAINT product_categories_category_same_tenant_fk
    FOREIGN KEY (tenant_id, category_id)
    REFERENCES categories (tenant_id, id)
    ON DELETE CASCADE;
