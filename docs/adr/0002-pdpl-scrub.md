# ADR 0002 — PDPL scrub for audit_payloads

Status: accepted (Phase 0 interface; Phase 5 implementation)
Date: 2026-04-17

## Context

Saudi PDPL grants data subjects deletion rights with a 30-day response window
on validated requests. Our audit surface (prd.md §3.7) is intentionally
tamper-evident: `audit_log` is append-only, truncation-guarded, and carries
a per-tenant `row_hash` chain stamped in place by a BEFORE INSERT trigger.

Making `audit_log` itself deletable would defeat the whole tamper-evidence
story. Making it un-deletable full-stop would fail PDPL. The split is the
only path: keep the chain in `audit_log` (hashes only, never PII) and let the
PII-bearing payloads live in a separate, scrub-able `audit_payloads` table.

## Decision

Two tables (migrations/0000_init.sql; shape in `src/server/db/schema/audit.ts`):

- `audit_log` — metadata + hash chain. Append-only via triggers. Never contains PII.
- `audit_payloads` — `{ correlation_id, kind, tenant_id, payload }`. PK
  `(correlation_id, kind)`. Tenant-scoped with RLS. INSERT + SELECT allowed
  for `app_user`; UPDATE + DELETE denied for `app_user`.

Deletion path (migrations/0004_pdpl_scrub_stub.sql):

A SECURITY DEFINER function `pdpl_scrub_audit_payloads(correlation_ids uuid[],
scrub_request_id uuid)` is the only path through which rows can leave
`audit_payloads`. The function:

1. Looks up `scrub_request_id` against an approved scrub-requests table
   (`scrub_requests`, added in Phase 5) to verify operator auth, documented
   legal basis, and ticket reference.
2. DELETEs the matching rows from `audit_payloads`. RLS is bypassed because
   SECURITY DEFINER runs as the function owner; tenant scoping is enforced
   inside the function body using `current_setting('app.tenant_id')::uuid`.
3. Writes a tombstone row to `audit_log` with `operation='pdpl.scrub'`.

The tombstone's `input_hash` MUST hash the **scrub request metadata** —
user_id being scrubbed, legal basis, ticket reference, the list of
correlation_ids affected. It MUST NOT hash the PII being scrubbed. Hashing
the PII would preserve guessability and defeat the entire split: an attacker
with the peppered hash plus a candidate value for the PII could confirm
membership after the scrub.

### Why SECURITY DEFINER

RLS policies cannot reference the call stack. There is no way to say
"DELETE on audit_payloads is allowed when and only when the caller is the
scrub service fn." A SECURITY DEFINER function owned by the migrator
(not `app_user`) is the Postgres-native way to gate a privileged operation
behind code-level authorization while keeping the caller's role strictly
downgraded everywhere else.

### Search path pinning

The SECURITY DEFINER function has `SET search_path = public, pg_temp`. Without
pinning, a compromised user could create a shadowing function in a
user-writable schema higher in the search path and hijack the SECURITY
DEFINER execution context. Pinning closes that attack class.

### Phase 0 stub

The function is in place with a `RAISE EXCEPTION 'not yet implemented'` body.
EXECUTE is granted to `app_user` so service code can import and reference the
symbol without a migration dependency when Phase 5 fills in the body. The
privilege topology (no direct DELETE on audit_payloads for `app_user`, narrow
EXECUTE on the function) is locked down now so the attack surface does not
widen inadvertently.

## Consequences

- Chunk 6's audit middleware has a stable interface to target for the scrub
  path when Phase 5 lands.
- Any attempt to DELETE from `audit_payloads` via ordinary `app_user` SQL
  fails with a "permission denied" error — visible and investigable.
- The tombstone pattern means chain-head verification still works after a
  scrub; the `row_hash` chain is unbroken, only the scrubbable payload rows
  are gone.
- Chain-head external witnessing (weekly digest emailed to tenant owner) is
  a Phase 4+ deliverable — see `docs/runbooks/audit-log.md`.
