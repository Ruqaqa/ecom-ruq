import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
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
    slug: jsonb("slug").$type<LocalizedText>().notNull(),
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
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    slug: jsonb("slug").$type<LocalizedText>().notNull(),
    name: jsonb("name").$type<LocalizedText>().notNull(),
    description: jsonb("description").$type<LocalizedTextPartial>(),
    status: text("status").notNull().default("draft"),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
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
    index("products_category_id_idx").on(t.categoryId),
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
