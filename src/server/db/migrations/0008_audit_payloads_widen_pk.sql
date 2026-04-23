-- Surrogate uuid PK on audit_payloads so two audit_log rows that deliberately
-- share a correlationId (see sessionCreateAfter magic-link branch) can each
-- carry their own input/before/after detail rows. The previous
-- (correlation_id, kind) composite PK collided on magic-link verify and the
-- losing write's whole transaction rolled back, dropping both the detail and
-- the headline row.

ALTER TABLE audit_payloads
  DROP CONSTRAINT audit_payloads_correlation_id_kind_pk;

ALTER TABLE audit_payloads
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE audit_payloads
  ADD CONSTRAINT audit_payloads_pkey PRIMARY KEY (id);

CREATE INDEX audit_payloads_correlation_id_kind_idx
  ON audit_payloads (correlation_id, kind);
