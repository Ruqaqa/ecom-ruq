import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, unique, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { LocalizedText, LocalizedTextPartial } from "@/lib/i18n/localized";
import { tenants } from "./tenants";

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // Latin-only URL slug, single value shared across both locales
    // (owner explicitly chose Latin URLs over Arabic-script URLs for
    // share-ability). Bilingual `name`/`description` still apply at
    // the JSONB column level. Per-tenant unique among non-soft-deleted
    // rows via the partial index below; collisions map to
    // SlugTakenError via extractPgUniqueViolation.
    slug: text("slug").notNull(),
    name: jsonb("name").$type<LocalizedText>().notNull(),
    description: jsonb("description").$type<LocalizedTextPartial>(),
    parentId: uuid("parent_id"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("categories_tenant_id_idx").on(t.tenantId),
    index("categories_tenant_parent_idx").on(t.tenantId, t.parentId),
    // Partial unique on live (non-deleted) rows — a soft-deleted row
    // can keep its slug without blocking a new live row that wants to
    // reuse it. See migrations/0009_categories_m2m_and_latin_slug.sql.
    uniqueIndex("categories_tenant_slug_unique_live")
      .on(t.tenantId, t.slug)
      .where(sql`deleted_at IS NULL`),
    // Anchors the composite FK on parent_id so a parent must live in
    // the same tenant. See migrations/0010_categories_same_tenant_fks.sql.
    unique("categories_tenant_id_id_unique").on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.parentId],
      foreignColumns: [t.tenantId, t.id],
      name: "categories_parent_same_tenant_fk",
    }).onDelete("cascade"),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // Latin-only URL slug (lowercase, digits, hyphens). Arabic slugs
    // percent-encode into URL-garbage and KSA e-commerce convention
    // uses Latin/transliterated identifiers. `name` stays bilingual
    // for display; `slug` is URL-layer only.
    slug: text("slug").notNull(),
    name: jsonb("name").$type<LocalizedText>().notNull(),
    description: jsonb("description").$type<LocalizedTextPartial>(),
    status: text("status").notNull().default("draft"),
    // Tier-B per prd.md §6.5 — operator-only; see src/server/services/products/create-product.ts
    // for the Zod output-gate that drops this column for non-admin roles.
    costPriceMinor: integer("cost_price_minor"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("products_tenant_id_idx").on(t.tenantId),
    index("products_tenant_status_idx").on(t.tenantId, t.status),
    // Unique-per-tenant — slug collisions map to pg 23505 →
    // mapErrorToAuditCode 'conflict'. Phase 1a admin-edit-slug flow
    // uses this as the anchor for a redirects table (prd.md §3.4).
    uniqueIndex("products_tenant_slug_unique").on(t.tenantId, t.slug),
    // Anchors the composite FKs on product_categories so the join
    // row's tenant must match the product's tenant.
    unique("products_tenant_id_id_unique").on(t.tenantId, t.id),
  ],
);

// Many-to-many link between products and categories (chunk 1a.4.1).
// Composite PK on (product_id, category_id) blocks duplicate links.
// Composite FKs on (tenant_id, product_id) and (tenant_id, category_id)
// guarantee the join row's tenant matches both parents at the data layer.
// See migrations/0010_categories_same_tenant_fks.sql.
export const productCategories = pgTable(
  "product_categories",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    categoryId: uuid("category_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.categoryId] }),
    index("product_categories_category_idx").on(t.categoryId, t.productId),
    index("product_categories_tenant_idx").on(t.tenantId),
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
      name: "product_categories_product_same_tenant_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.categoryId],
      foreignColumns: [categories.tenantId, categories.id],
      name: "product_categories_category_same_tenant_fk",
    }).onDelete("cascade"),
  ],
);

export const productOptions = pgTable(
  "product_options",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    name: jsonb("name").$type<LocalizedText>().notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("product_options_product_id_idx").on(t.productId)],
);

export const productOptionValues = pgTable(
  "product_option_values",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => productOptions.id, { onDelete: "cascade" }),
    value: jsonb("value").$type<LocalizedText>().notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("product_option_values_option_id_idx").on(t.optionId)],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    priceMinor: integer("price_minor").notNull(),
    currency: text("currency").notNull().default("SAR"),
    stock: integer("stock").notNull().default(0),
    optionValueIds: jsonb("option_value_ids").$type<string[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("product_variants_product_id_idx").on(t.productId),
    uniqueIndex("product_variants_tenant_sku_unique").on(t.tenantId, t.sku),
  ],
);
