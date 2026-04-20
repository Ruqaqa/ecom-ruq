/**
 * Audit is split per security review into:
 *   - audit_log: metadata + hash chain, append-only and truncation-guarded.
 *     Tamper-evident. NEVER contains payloads. Not deletable.
 *   - audit_payloads: full request/before/after jsonb. Tenant-scoped. PDPL-
 *     deletable via the SECURITY DEFINER `pdpl_scrub_audit_payloads` function
 *     (migrations/0004). `app_user` does NOT have direct DELETE privilege.
 *
 * Hash chain on `audit_log`:
 *   row_hash = HMAC-SHA-256(
 *     HASH_PEPPER,
 *     canonical_json({metadata + input_hash/before_hash/after_hash + prev_log_hash})
 *   )
 *   prev_log_hash = row_hash of the immediately-preceding row for this tenant,
 *                   NULL for the first row. Computed and filled in by the
 *                   BEFORE INSERT trigger (migrations/0003), which serializes
 *                   writers per tenant via pg_advisory_xact_lock.
 *
 * Payload-content hashes (input_hash, before_hash, after_hash) are
 * HMAC-SHA-256(HASH_PEPPER, canonical_json(redactForAudit(payload))).
 * Tombstone rows written by PDPL scrub MUST hash only the scrub request
 * metadata, NEVER the PII being scrubbed — see docs/adr/0002-pdpl-scrub.md.
 *
 * Canonicalization: RFC 8785 JCS via the `canonicalize` npm package.
 *
 * Platform-scope audit (when super-admin lands later) uses a separate
 * `audit_payloads_platform` table written only by `app_platform` — do NOT
 * mix NULL-tenant and tenant-scope payloads in one RLS-bound table. That
 * table is deliberately absent in Phase 0 (no platform writers exist yet).
 *
 * Writers MUST run inside the service adapter's transaction. Never write
 * audit directly from a service function — see src/server/services/README.md.
 */
import { pgTable, uuid, text, timestamp, jsonb, index, primaryKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { bytea } from "./_types";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),
    correlationId: uuid("correlation_id").notNull(),
    operation: text("operation").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    outcome: text("outcome").notNull(),
    actorType: text("actor_type").notNull(),
    // `actor_id` is text, not uuid. Audit carries user.id, access_tokens.id,
    // or string sentinels like 'system' and 'agent:<name>'. Keeping this
    // as text is truthful to the data; a uuid type would force a "synthetic
    // uuid for system" convention nobody would remember.
    actorId: text("actor_id"),
    // `token_id` has no FK to access_tokens(id). Audit must survive PAT
    // revocation and deletion: ON DELETE RESTRICT would block PAT cleanup,
    // and ON DELETE SET NULL would scrub forensic evidence. Column type is
    // text here for parity with actor_id (reads as a stringly-typed
    // identifier; chain.ts canonicalizes as a string regardless).
    tokenId: text("token_id"),
    prevLogHash: bytea("prev_log_hash"),
    inputHash: bytea("input_hash"),
    beforeHash: bytea("before_hash"),
    afterHash: bytea("after_hash"),
    rowHash: bytea("row_hash").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("audit_log_correlation_idx").on(t.correlationId),
    index("audit_log_operation_idx").on(t.operation),
  ],
);

export const auditPayloads = pgTable(
  "audit_payloads",
  {
    correlationId: uuid("correlation_id").notNull(),
    kind: text("kind").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.correlationId, t.kind] }),
    index("audit_payloads_tenant_id_idx").on(t.tenantId),
    check("audit_payloads_kind_check", sql`${t.kind} IN ('input','before','after')`),
  ],
);
