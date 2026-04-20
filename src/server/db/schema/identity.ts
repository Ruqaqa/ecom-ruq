/**
 * Tier-A identity data (Nafath-prep per prd.md §5, §6.5).
 *
 * Payload blob is self-describing. Byte 0 is the format version; the rest is
 * dispatched by the envelope helpers on that byte.
 *
 *   format_version = 1  (AES-256-GCM)
 *     byte 0          = 0x01
 *     bytes 1..12     = 12-byte GCM nonce
 *     bytes 13..N-16  = ciphertext
 *     bytes N-16..N   = 16-byte GCM auth tag
 *
 * `format_version` is also kept as a column for fast filtering and audit.
 * A future bump to XChaCha20-Poly1305 is format_version = 2 with a different
 * nonce length — no schema change required, because the blob describes itself.
 *
 * AAD for Tier-A payload: tenant_id || identity_verifications.id || dek_version
 * AAD for DEK wrapping:   tenant_id || dek_version
 *
 * See src/server/crypto/envelope.ts for the encrypt/decrypt helpers.
 */
import { pgTable, uuid, text, timestamp, integer, smallint, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { user } from "./auth";
import { bytea } from "./_types";

export const tenantKeys = pgTable("tenant_keys", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  wrappedDek: bytea("wrapped_dek").notNull(),
  dekVersion: integer("dek_version").notNull().default(1),
  formatVersion: smallint("format_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const identityVerifications = pgTable(
  "identity_verifications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    level: text("level").notNull(),
    status: text("status").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    payload: bytea("payload"),
    dekVersion: integer("dek_version").notNull().default(1),
    formatVersion: smallint("format_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("identity_verifications_tenant_user_idx").on(t.tenantId, t.userId),
    index("identity_verifications_tenant_status_idx").on(t.tenantId, t.status),
    // Cheap guard against truncated ciphertext blobs. Minimum V1 envelope:
    // 1-byte version + 12-byte nonce + 1-byte plaintext + 16-byte tag = 30.
    check(
      "identity_verifications_payload_min_length",
      sql`${t.payload} IS NULL OR octet_length(${t.payload}) >= 30`,
    ),
  ],
);
