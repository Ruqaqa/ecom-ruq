/**
 * Personal access tokens (PATs) for MCP / API use.
 *
 * Storage shape: HMAC-SHA-256(TOKEN_HASH_PEPPER, token_plaintext) as 32-byte bytea.
 * Plaintext format: `eruq_pat_<base64url(32 random bytes)>`. Prefix stored separately
 * (8 chars of plaintext after the secret portion) for human-recognition in the admin UI.
 *
 * Issuance and lookup: chunk 7 (MCP server). Chunk 4 only defines the schema + CHECK
 * constraint. See docs/adr/0001-pat-storage.md for the Better Auth extension approach.
 *
 * `CHECK (tenant_id IS NOT NULL)` enforces tenant-scoping for Phase 0. Drop it when
 * super-admin lands.
 */
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { user } from "./auth";
import { bytea } from "./_types";

export const accessTokens = pgTable(
  "access_tokens",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: bytea("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    scopes: jsonb("scopes").notNull().default(sql`'{}'::jsonb`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("access_tokens_hash_unique").on(t.tokenHash),
    index("access_tokens_tenant_id_idx").on(t.tenantId),
    index("access_tokens_user_id_idx").on(t.userId),
    check("access_tokens_tenant_not_null", sql`${t.tenantId} IS NOT NULL`),
  ],
);
