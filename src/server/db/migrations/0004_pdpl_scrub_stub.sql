-- PDPL scrub path for audit_payloads.
--
-- `app_user` does NOT have DELETE privilege on audit_payloads. The ONLY way
-- to delete is through the SECURITY DEFINER function below, which is owned
-- by the migrator. Actual scrub logic (operator auth check, ticket lookup,
-- tombstone insertion) is a Phase 5 compliance deliverable; this migration
-- establishes the interface + the privilege topology so chunk 4 is the last
-- time audit_payloads grants get touched in a core-surface way.
--
-- See docs/adr/0002-pdpl-scrub.md for the full design.

-- Revoke app_user's DELETE on audit_payloads granted in 0001. Keep SELECT/INSERT.
REVOKE DELETE ON audit_payloads FROM app_user;

CREATE OR REPLACE FUNCTION pdpl_scrub_audit_payloads(
  correlation_ids uuid[],
  scrub_request_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
-- Fixed search_path to prevent search_path attacks on SECURITY DEFINER fns.
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Phase 0 stub. Phase 5 implementation will:
  --   1. Verify scrub_request_id references an approved scrub request
  --      (table scrub_requests, introduced in Phase 5) with operator auth,
  --      legal basis, and ticket reference.
  --   2. DELETE FROM audit_payloads WHERE correlation_id = ANY(correlation_ids)
  --      AND tenant_id = current_setting('app.tenant_id')::uuid.
  --      (Bypasses RLS because SECURITY DEFINER runs as the function owner.
  --      Tenant scoping is therefore enforced IN the function body.)
  --   3. INSERT a tombstone row into audit_log with operation='pdpl.scrub'.
  --      The input_hash MUST hash the scrub request metadata (user_id,
  --      legal_basis, ticket ref, correlation_ids list), NEVER the PII.
  RAISE EXCEPTION 'pdpl_scrub_audit_payloads: not yet implemented (Phase 5)'
    USING ERRCODE = '0A000';
END;
$$;

-- Only the migrator (owner) can EXECUTE the function by default with SECURITY
-- DEFINER. Grant EXECUTE to app_user so service code can call it; authorization
-- is enforced inside the function body.
REVOKE ALL ON FUNCTION pdpl_scrub_audit_payloads(uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pdpl_scrub_audit_payloads(uuid[], uuid) TO app_user;
