import { pgTable, uuid, text, timestamp, index, uniqueIndex, jsonb, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { LocalizedText } from "@/lib/i18n/localized";

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    slug: text("slug").notNull(),
    primaryDomain: text("primary_domain").notNull(),
    defaultLocale: text("default_locale").notNull().default("ar"),
    status: text("status").notNull().default("active"),
    name: jsonb("name").$type<LocalizedText>().notNull(),
    // The From-address used for all transactional email. Per prd.md §3.6 this is
    // per-tenant; sendTenantEmail reads it from the resolved Tenant — never
    // from a Host header, never from caller-supplied state.
    senderEmail: text("sender_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenants_slug_unique").on(t.slug),
    uniqueIndex("tenants_primary_domain_unique").on(t.primaryDomain),
    index("tenants_status_idx").on(t.status),
    check("tenants_status_check", sql`${t.status} IN ('active','suspended','archived')`),
    check("tenants_sender_email_shape", sql`${t.senderEmail} ~ '^[^@\s]+@[^@\s]+$'`),
  ],
);
