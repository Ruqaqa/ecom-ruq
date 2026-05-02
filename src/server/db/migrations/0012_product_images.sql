-- Chunk 1a.7.1 — image pipeline foundation.
--
-- Adds the `product_images` table and the `product_variants.cover_image_id`
-- column. Mirrors the composite same-tenant FK pattern from migrations
-- 0010 (categories) and 0011 (variants) — the application-layer tenant
-- resolver is the primary mechanism, RLS is the safety net, and the
-- composite FKs are the data-layer belt that prevents a row whose
-- tenant_id disagrees with its parent.
--
-- Six-part change:
--   1. CREATE TABLE product_images with:
--      - `version int NOT NULL DEFAULT 1` (monotonic, bumped on replace).
--      - `fingerprint_sha256 text NOT NULL` (per-product duplicate key).
--      - `storage_key text NOT NULL` (key for the ORIGINAL file only;
--        derivative keys live in the `derivatives` JSONB ledger).
--      - `derivatives jsonb NOT NULL DEFAULT '[]'` denormalized ledger
--        of every derivative file. NOT an FK — storefront renders
--        explicit width/height per <img> from this.
--      - `alt_text jsonb` bilingual partial; either side may be absent.
--   2. Indexes on (product_id) and (product_id, position).
--   3. UNIQUE (tenant_id, id) anchor for composite FKs from elsewhere.
--   4. Composite same-tenant FK to products on (tenant_id, product_id),
--      ON DELETE CASCADE so a product purge takes its images.
--   5. Per-product fingerprint duplicate detection — UNIQUE (product_id,
--      fingerprint_sha256). The cap of 10 images per product is NOT a
--      CHECK (can't span rows); enforced in the service via SELECT count
--      inside the per-product advisory lock.
--   6. ALTER product_variants ADD `cover_image_id uuid` (nullable, 0 or 1
--      per variant) + UNIQUE (tenant_id, id) anchor + composite same-
--      tenant FK to product_images. ON DELETE SET NULL — image gone →
--      variant cover falls back to product cover (position 0).
--
-- RLS: same-tenant policy + GRANT SELECT/INSERT/UPDATE/DELETE to app_user.
-- Mirrors every other tenant-scoped table in 0002.

CREATE TABLE product_images (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id          uuid NOT NULL,
  position            integer NOT NULL DEFAULT 0,
  -- Monotonic counter bumped on `replaceProductImage`. Used in storage
  -- key derivation so a replace produces a NEW key (avoids CDN cache
  -- staleness + mid-replace partial-content windows). v1 on insert.
  version             integer NOT NULL DEFAULT 1,
  -- SHA-256 hex of the original input bytes. Per-product duplicate
  -- detection key.
  fingerprint_sha256  text NOT NULL,
  -- Adapter's opaque storage key for the ORIGINAL file (pre-derivative).
  -- Format: "<tenant-slug>/<product-slug>-<position>-v<version>-original.<ext>"
  storage_key         text NOT NULL,
  original_format     text NOT NULL,
  original_width      integer NOT NULL,
  original_height     integer NOT NULL,
  original_bytes      integer NOT NULL,
  -- Denormalized ledger of every derivative file. JSONB array of
  -- { size, format, width, height, storageKey, bytes }. NOT an FK.
  -- Storefront renders explicit width/height per <img> from this.
  derivatives         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Bilingual partial. Either side may be absent.
  alt_text            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX product_images_product_id_idx
  ON product_images (product_id);
CREATE INDEX product_images_product_position_idx
  ON product_images (product_id, position);

-- Anchor for composite same-tenant FKs from elsewhere (mirrors the
-- products / categories / product_options pattern).
ALTER TABLE product_images
  ADD CONSTRAINT product_images_tenant_id_id_unique UNIQUE (tenant_id, id);

ALTER TABLE product_images
  ADD CONSTRAINT product_images_product_same_tenant_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES products (tenant_id, id)
    ON DELETE CASCADE;

CREATE UNIQUE INDEX product_images_product_fingerprint_unique
  ON product_images (product_id, fingerprint_sha256);

-- product_variants gets a (tenant_id, id) anchor so product_images can
-- reference variants in future surfaces, AND a cover_image_id column +
-- composite FK to product_images.
ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_tenant_id_id_unique UNIQUE (tenant_id, id);

ALTER TABLE product_variants
  ADD COLUMN cover_image_id uuid;

-- ON DELETE SET NULL with a column list (Postgres 15+) so only
-- cover_image_id is nulled when the image goes away — tenant_id stays
-- pinned to its parent product (nulling it would violate NOT NULL and
-- break the FK to products).
ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_cover_image_same_tenant_fk
    FOREIGN KEY (tenant_id, cover_image_id)
    REFERENCES product_images (tenant_id, id)
    ON DELETE SET NULL (cover_image_id);

-- RLS — same-tenant policy + grant. Mirrors 0002 / 0009.
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images FORCE ROW LEVEL SECURITY;
CREATE POLICY product_images_same_tenant ON product_images
  FOR ALL TO app_user
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON product_images TO app_user;
