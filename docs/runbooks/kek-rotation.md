# KEK rotation runbook

The data key-encryption key (KEK) is loaded from `DATA_KEK_BASE64` at boot and
used to wrap each tenant's data encryption key (DEK) in `tenant_keys.wrapped_dek`.
Rotation is a three-step process that avoids downtime and produces no plaintext
exposure outside the running Node process.

## 1. Generate and deploy the new KEK

Generate a new 32-byte KEK and make it available to the application alongside
the current one. Set `DATA_KEK_BASE64_PREVIOUS` to the *old* value and
`DATA_KEK_BASE64` to the *new* value. During rotation the app must accept both
— unwrap with `DATA_KEK_BASE64_PREVIOUS` when a DEK was wrapped under the old
key, and wrap new DEKs with `DATA_KEK_BASE64`.

```
# On the secret store (Coolify / GH Actions / local .env)
openssl rand -base64 32
# → put the new value in DATA_KEK_BASE64
# → move the old value to DATA_KEK_BASE64_PREVIOUS
```

Deploy. The app now boots with both KEKs loaded. Data writes use the new KEK;
legacy data reads transparently fall through to the old KEK for DEKs with
`dek_version < current`.

## 2. Rewrap all tenant DEKs under the new KEK

Run the rewrap job (one-shot script, to be added in a follow-up chunk). It
iterates `tenant_keys` in tenant-scoped batches:

- unwrap `wrapped_dek` with `DATA_KEK_BASE64_PREVIOUS`
- rewrap the (still random, unchanged) DEK with `DATA_KEK_BASE64`
- bump `dek_version`
- update the row atomically

The DEK itself does not change, so no Tier-A payloads need to be re-encrypted.
This is the whole point of envelope encryption — only the wrap layer rotates.

Verify with a `SELECT count(*) FROM tenant_keys WHERE dek_version < :current`
query. It must return zero when the job completes.

## 3. Retire the old KEK

Once every `tenant_keys` row is on the new `dek_version`, remove
`DATA_KEK_BASE64_PREVIOUS` from the secret store and redeploy. The old KEK is
then unrecoverable from application state. Destroy the old KEK value in whatever
key custody system held it (hardware token, Coolify secret history, etc.)
according to your key destruction policy.

## Operational notes

- Rotation cadence: annually, plus any compromise-driven rotation.
- Boot-time KEK validation (`src/server/crypto/envelope.ts::loadKek`) refuses
  to start the app if either KEK value is missing, non-base64, not exactly 32
  bytes, all-zeros, or matches a known dev placeholder (`change-me`, `dev`,
  `placeholder`, `test`). This catches copy-paste mistakes during rotation.
- The rewrap job must run as a role with access to `tenant_keys` — in Phase 0
  that means `app_user` with `withTenant` for each tenant. Do not run rewraps
  as `app_migrator`.
