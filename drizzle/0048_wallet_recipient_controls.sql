-- Wallet recipients (v2 §4.7): the controls the §4.7 review found missing.
--
-- 1. Maker-checker: who saved a wallet recipient, and the owner who approved
--    it. A recipient a staff member saved is paid or tagged only once an
--    owner approves it; an owner's own save is approved by that owner.
--    Existing wallet recipients have no approval and wait for one.
-- 2. The ownership proof: when it was proven and by which challenge, and an
--    epoch that every withdrawal moves on. A challenge records the epoch it
--    was made in; a signature for an older epoch proves nothing, so an
--    owner's withdrawal is never undone by a check that finishes after it.
--    A link whose email failed for a staff member is closed (email_failed).
-- 3. A Solana mint recipient: the token account's owner as the chain showed
--    it when the recipient was saved.
-- 4. One EVM transaction may carry the mints of several CCTP messages: the
--    mint is unique per chain, transaction and message nonce.

ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "approved_by" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "ownership_epoch" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "ownership_proven_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "ownership_challenge_id" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "destination_token_owner" text;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_approval_check" CHECK (("approved_by" IS NULL) = ("approved_at" IS NULL));
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_token_owner_check" CHECK ("destination_token_owner" IS NULL OR COALESCE("destination_chain" = 'SOLANA', false));
--> statement-breakpoint
ALTER TABLE "recipient_ownership_challenges" ADD COLUMN IF NOT EXISTS "recipient_epoch" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- A link a staff member asked for whose email failed is closed at once
-- (nobody was sent it, and staff are not shown it).
ALTER TABLE "recipient_ownership_challenges" DROP CONSTRAINT IF EXISTS "recipient_ownership_challenges_outcome_check";
--> statement-breakpoint
ALTER TABLE "recipient_ownership_challenges" ADD CONSTRAINT "recipient_ownership_challenges_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('verified', 'bad_signature', 'superseded', 'withdrawn', 'email_failed'));
--> statement-breakpoint
ALTER TABLE "cross_chain_transfers" DROP CONSTRAINT IF EXISTS "cross_chain_transfers_mint_unique";
--> statement-breakpoint
ALTER TABLE "cross_chain_transfers" ADD CONSTRAINT "cross_chain_transfers_mint_unique" UNIQUE ("destination_chain", "mint_tx_hash", "message_nonce");
