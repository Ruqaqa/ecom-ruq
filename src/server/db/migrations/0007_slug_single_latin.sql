-- Chunk 6 amendment (post-e4d3844): slug is Latin-only single text, not
-- bilingual JSONB. Arabic characters percent-encode into URL garbage;
-- KSA e-commerce convention uses ASINs / product IDs / transliterated
-- Latin slugs. `name` stays bilingual for display; `slug` is URL-layer
-- only.
--
-- Dev DB has no real data at chunk-6-landing time, so drop-and-recreate
-- is safe. Production data migration is a Phase 1a concern when the
-- admin-edit-slug flow lands; the unique index below means that flow
-- is wiring + UI, not schema work.
--
-- The unique-per-tenant index sets up the Phase 1a redirects table
-- join (prd.md §3.4: 301 redirects on slug changes, admin-managed).
-- Collisions at insert-time throw pg 23505, which block-2's
-- mapErrorToAuditCode routes to `errorCode: 'conflict'`.

-- Dev DB may have leftover rows from prior test runs. Drop them
-- before reshaping the column — chunk-6-landing-time dev state only.
-- Phase 1a production migration will not use this drop.
DELETE FROM products;

ALTER TABLE products DROP COLUMN slug;
ALTER TABLE products ADD COLUMN slug text NOT NULL;
CREATE UNIQUE INDEX products_tenant_slug_unique ON products (tenant_id, slug);
