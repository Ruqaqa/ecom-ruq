-- Chunk 6 block 3: add Tier-B cost_price placeholder column to products.
--
-- cost_price_minor is Tier-B per prd.md §6.5 — operator-only. The column
-- lives here so the Zod output-gating pattern in
-- src/server/services/products/create-product.ts has a real asymmetric
-- field to return for owner/staff vs. omit for customer/anonymous.
--
-- Minor units (halalas for SAR) matching the price scheme planned for
-- product_variants.price_minor in Phase 1a. Nullable: not every product
-- has a known cost price, and the write path lands later.
--
-- RLS: no new policy. The existing tenant-scoped policy on `products`
-- covers every column including this one — RLS is row-level, not
-- column-level. The Tier-B gate is the Zod output schema, not pg.

ALTER TABLE products ADD COLUMN cost_price_minor integer;

COMMENT ON COLUMN products.cost_price_minor IS
  'Tier-B per prd.md §6.5 — operator-only, never exposed to customers. Minor units (halalas for SAR).';
