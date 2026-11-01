-- The name and title of a person who declined, kept as they were (v2 Phase 3, p3-decliners).
--
-- Sky's decision: "Declined by Aisha (CFO)" must survive Aisha leaving the business,
-- being renamed, or her account being removed. The label used to be read from the live
-- user row, so any of those changed or blanked an old one. It is now a snapshot written
-- in the same statement that records the decline:
--
--   wallet_signing_signers.declined_name / declined_title   a signer who declined a request
--   wallet_approval_asks.decided_name / decided_title       the owner who declined an ask
--
-- Only the name and the title, both already cleaned to plain words by the app before they
-- are written (lib/team/declined-by.ts); nothing else about the person. An empty string
-- means "a snapshot was taken and nothing usable was left"; NULL means the decline was
-- recorded before this migration, and the app reads the person's live name and title while
-- they are still a member, else says "an owner". No existing row is rewritten.
--
-- The signer row's foreign key to users is removed. It deleted the signer row along
-- with the account, so removing an account removed the record that the person declined,
-- and the snapshot with it. A
-- decline is evidence of what a person did, like the audit trail (which already keeps the
-- ids of people who are gone) and the approval asks (0037), so it outlives the account.
-- The column stays NOT NULL and part of the primary key. Nothing is dropped but that one
-- constraint, by name, and the statement can run twice.
ALTER TABLE "wallet_signing_signers" ADD COLUMN IF NOT EXISTS "declined_name" text;
--> statement-breakpoint
ALTER TABLE "wallet_signing_signers" ADD COLUMN IF NOT EXISTS "declined_title" text;
--> statement-breakpoint
ALTER TABLE "wallet_approval_asks" ADD COLUMN IF NOT EXISTS "decided_name" text;
--> statement-breakpoint
ALTER TABLE "wallet_approval_asks" ADD COLUMN IF NOT EXISTS "decided_title" text;
--> statement-breakpoint
ALTER TABLE "wallet_signing_signers" DROP CONSTRAINT IF EXISTS "wallet_signing_signers_user_id_fkey";
