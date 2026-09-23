-- The stablecoin lane settles on Sui MAINNET only (decision 2026-09-24). The
-- sandbox covers USD in and local-currency out, where the partners offer one;
-- a testnet USDC transfer proves nothing a business can rely on. The
-- per-workspace network switch from 0020 goes, and the ledger says so.
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "stablecoin_network";
--> statement-breakpoint
ALTER TABLE "stablecoin_outflows" DROP CONSTRAINT IF EXISTS "stablecoin_outflows_network_check";
--> statement-breakpoint
ALTER TABLE "stablecoin_outflows" ADD CONSTRAINT "stablecoin_outflows_network_check" CHECK ("network" = 'mainnet');
--> statement-breakpoint
-- The fingerprint of a confirmed wallet transfer, for the audit trail: a
-- sha256 over the canonical record (lib/payments/stablecoin-verify.ts). Kept
-- here until Splash's contracts are published on mainnet to anchor it.
ALTER TABLE "stablecoin_outflows" ADD COLUMN "audit_hash" text;
--> statement-breakpoint
-- A CONFIRMED row is a payment Splash has verified on chain. It must carry the
-- digest that proves it and the hash that records it. COALESCE because a
-- CHECK that evaluates to NULL passes.
ALTER TABLE "stablecoin_outflows" ADD CONSTRAINT "stablecoin_outflows_confirmed_proof_check" CHECK (
  "status" <> 'CONFIRMED'
  OR (
    "tx_digest" IS NOT NULL
    AND "confirmed_at" IS NOT NULL
    AND COALESCE(length("audit_hash") = 64, false)
  )
);
