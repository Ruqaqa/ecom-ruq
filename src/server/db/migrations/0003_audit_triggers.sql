-- Append-only + hash-chain triggers on audit_log.
--
-- (1) Mutation guard: BEFORE UPDATE/DELETE/TRUNCATE raises. Belt and braces
-- with the REVOKE TRUNCATE in 0001.
--
-- (2) Chain verifier: BEFORE INSERT acquires a per-tenant advisory xact
-- lock, reads the authoritative previous row_hash for this tenant, and
-- VERIFIES that the application-supplied `prev_log_hash` matches. A
-- mismatch raises SQLSTATE 40001 (serialization_failure) so the chunk 6
-- audit middleware recognizes this as a retryable transaction — the
-- canonical cause is "app read prev without holding the advisory lock,
-- so a concurrent writer slipped a row in between." After the check the
-- trigger re-stamps prev_log_hash with the authoritative value.
--
-- Triggers cannot compute HMACs (no access to HASH_PEPPER) — that is by
-- design; the chain's row_hash is computed in Node by the audit middleware
-- (src/server/audit/chain.ts). The trigger's role is to enforce the
-- ordering invariant and sanity-check row_hash shape.
--
-- See docs/runbooks/audit-log.md for the chain verification procedure.

CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (operation % blocked)', TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutation();

-- Chain verifier. One row per tenant wins the advisory lock at a time;
-- different tenants do not contend. The lock is released on commit/rollback.
-- Platform-scope rows (tenant_id IS NULL) share a single chain keyed by a
-- magic all-zeros UUID — Phase 0 has no platform writers so this branch is
-- dormant; it is kept for forward compatibility with super-admin.
CREATE OR REPLACE FUNCTION audit_log_verify_chain() RETURNS trigger AS $$
DECLARE
  expected bytea;
  lock_key text;
BEGIN
  lock_key := 'audit_log:' || COALESCE(NEW.tenant_id::text, '00000000-0000-0000-0000-000000000000');
  PERFORM pg_advisory_xact_lock(hashtext(lock_key));

  SELECT row_hash INTO expected
  FROM audit_log
  WHERE (NEW.tenant_id IS NULL AND tenant_id IS NULL)
     OR (NEW.tenant_id IS NOT NULL AND tenant_id = NEW.tenant_id)
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  -- Chain-race check. The app computes NEW.prev_log_hash in Node, which
  -- requires holding the same per-tenant advisory lock as this trigger.
  -- If they disagree, the app read prev WITHOUT holding this lock and a
  -- concurrent writer slipped a row in between. Raise SQLSTATE 40001
  -- (serialization_failure) so the chunk 6 audit middleware recognizes
  -- this as a retryable transaction, exactly like a serialization conflict.
  IF NEW.prev_log_hash IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'audit_log chain race: app-supplied prev_log_hash does not match trigger-computed prev for tenant %',
      COALESCE(NEW.tenant_id::text, 'platform')
      USING ERRCODE = '40001',
            HINT = 'acquire pg_advisory_xact_lock(hashtext(''audit_log:'' || tenant_id)) before computing row_hash';
  END IF;

  -- Authoritative stamp (at this point NEW.prev_log_hash already equals
  -- `expected` — this is belt-and-braces so downstream code sees the
  -- trigger-computed value unambiguously).
  NEW.prev_log_hash := expected;

  -- Sanity: row_hash must be 32 bytes (SHA-256 digest length).
  IF octet_length(NEW.row_hash) <> 32 THEN
    RAISE EXCEPTION 'audit_log.row_hash must be 32 bytes, got %', octet_length(NEW.row_hash)
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_verify_chain();
