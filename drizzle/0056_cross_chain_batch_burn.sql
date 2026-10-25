-- v2 §4.7 (D5c): one owners' multisig transaction may pay several
-- cross-chain payments (a batch is one signature for one PTB, §5.6), so a
-- Sui digest may be the burn of more than one receipt. Each receipt still
-- records the burn only after reading that the transaction confirmed its
-- own intent (lib/server/cross-chain-transfers.ts recordCrossChainBurn), and
-- each takes its own Circle message: message_nonce stays unique.
ALTER TABLE "cross_chain_transfers" DROP CONSTRAINT IF EXISTS "cross_chain_transfers_burn_unique";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cross_chain_transfers_burn_idx" ON "cross_chain_transfers" ("burn_digest");
