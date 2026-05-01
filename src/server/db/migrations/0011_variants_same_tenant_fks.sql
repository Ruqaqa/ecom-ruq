-- Chunk 1a.5.1 — same-tenant data-layer guarantees for variants.
--
-- Defense-in-depth from the security review of 1a.5.1 (spec §5).
-- Extends migration 0010's composite-FK pattern to product_options,
-- product_option_values, and product_variants. Without this, only the
-- application layer prevents a row whose tenant_id disagrees with its
-- parent's tenant_id. CLAUDE.md §5: RLS is the safety net; this is the
-- matching belt.
--
-- Five changes:
--   1. UNIQUE (tenant_id, id) on product_options and product_option_values
--      so they can be the targets of composite FKs. Redundant for query
--      planning (id alone is PK), required to anchor the composite FK.
--   2. Replace the single-column FK on product_options.product_id with
--      a composite (tenant_id, product_id) FK so a product_options row
--      must live in the same tenant as its product.
--   3. Replace the single-column FK on product_option_values.option_id
--      with a composite (tenant_id, option_id) FK. ON DELETE CASCADE is
--      LOAD-BEARING for 1a.5.3's "remove option type" flow: deleting a
--      product_options row physically deletes its values; the variant
--      cleanup (the jsonb optionValueIds[] is not an FK) is then app-
--      layer.
--   4. Replace the single-column FK on product_variants.product_id with
--      a composite (tenant_id, product_id) FK.
--   5. CHECK constraint asserting product_variants.option_value_ids is
--      a JSONB array of length ≤ 3 (matches MAX_OPTIONS_PER_PRODUCT).
--      The Zod schema is the primary cap; this is belt-and-braces in
--      the same spirit as the composite FKs.

ALTER TABLE product_options
  ADD CONSTRAINT product_options_tenant_id_id_unique UNIQUE (tenant_id, id);

ALTER TABLE product_option_values
  ADD CONSTRAINT product_option_values_tenant_id_id_unique UNIQUE (tenant_id, id);

-- Drizzle 0000_init named the single-column FK constraints with the
-- drizzle convention `<table>_<column>_<ref-table>_<ref-column>_fk`.
ALTER TABLE product_options
  DROP CONSTRAINT product_options_product_id_products_id_fk;
ALTER TABLE product_options
  ADD CONSTRAINT product_options_product_same_tenant_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES products (tenant_id, id)
    ON DELETE CASCADE;

ALTER TABLE product_option_values
  DROP CONSTRAINT product_option_values_option_id_product_options_id_fk;
ALTER TABLE product_option_values
  ADD CONSTRAINT product_option_values_option_same_tenant_fk
    FOREIGN KEY (tenant_id, option_id)
    REFERENCES product_options (tenant_id, id)
    ON DELETE CASCADE;

ALTER TABLE product_variants
  DROP CONSTRAINT product_variants_product_id_products_id_fk;
ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_product_same_tenant_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES products (tenant_id, id)
    ON DELETE CASCADE;

ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_option_value_ids_max_3
    CHECK (jsonb_typeof(option_value_ids) = 'array'
       AND jsonb_array_length(option_value_ids) <= 3);
