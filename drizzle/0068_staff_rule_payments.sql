-- Staff payments inside a rule (v2 Phase 3, decision D2): a staff member whose
-- spending rule covers the amount, the recipient and the time window pays
-- alone from Transfer, in one transaction signed by their own passkey
-- (`splash_spend::pay_intent`). Anything outside the rule is still an ask to
-- the owners.
--
-- wallet_signing_requests: the purpose `staff_rule_payment` is added to the
-- list the table allows (the same list as 0065, plus this one).
--
-- wallet_transfers: the route `staff_rule` is added beside `owners_sign` and
-- `asked_owners`. The index serves the one question the server asks before it
-- lets a second payment claim what a first has not yet spent: what has this
-- person already asked for that the chain has not counted?
ALTER TABLE "wallet_signing_requests" DROP CONSTRAINT IF EXISTS "wallet_signing_requests_purpose_check";
--> statement-breakpoint
ALTER TABLE "wallet_signing_requests" ADD CONSTRAINT "wallet_signing_requests_purpose_check" CHECK ("purpose" IN ('nominate_wallet', 'register_wallet', 'rotate_wallet', 'confirm_wallet_rotation', 'cancel_wallet_rotation', 'wallet_membership', 'wallet_payment', 'wallet_batch', 'migration_transfer', 'rotation_transfer', 'spend_policy', 'spend_rule', 'spend_approval', 'staff_rule_payment', 'withdrawal', 'partner_test_deposit', 'partner_payout', 'subscription'));
--> statement-breakpoint
ALTER TABLE "wallet_transfers" DROP CONSTRAINT IF EXISTS "wallet_transfers_route_check";
--> statement-breakpoint
ALTER TABLE "wallet_transfers" ADD CONSTRAINT "wallet_transfers_route_check" CHECK ("route" IN ('owners_sign', 'asked_owners', 'staff_rule'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_transfers_org_requester_idx" ON "wallet_transfers" ("org_id", "requested_by");
