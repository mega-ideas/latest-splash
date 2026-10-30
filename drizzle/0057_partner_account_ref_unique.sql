-- v2 Phase 2 §4.5: a payout partner's webhook names a business by the account
-- reference the partner gave with its deposit address
-- (depositAddressForWebhook). Two live rows with one reference would make that
-- lookup ambiguous across businesses, so a reference is one business's, per
-- partner, while the row is live. A revoked row frees it.
--
-- If this fails on existing data, two live rows share a reference: revoke the
-- wrong one (a staff action recorded in withdrawal_events) and run it again.
CREATE UNIQUE INDEX IF NOT EXISTS "partner_deposit_addresses_account_ref_unique" ON "partner_deposit_addresses" ("partner", "account_ref") WHERE "status" <> 'revoked';
