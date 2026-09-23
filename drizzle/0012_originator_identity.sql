-- The payer's own half of the travel rule.
--
-- Migration 0006 gave `suppliers` everything FATF R.16 asks about the
-- BENEFICIARY — legal identity, address, bank routing scheme, screening
-- verdict. It gave the ORIGINATOR nothing, and R.16 has two halves: the
-- sender's name, their account, and at least one identifier (an address, a
-- registration number, a national id) must accompany the payment too.
--
-- `organizations` had `legal_name` and nothing else. The registration number
-- existed only inside an in-memory KYB case object, and the address existed
-- nowhere at all. So a partner asking us to produce a complete travel-rule
-- record for a payment we sent could not be answered, however carefully the
-- beneficiary side had been filled in.
--
-- These are org-level facts, established once at KYB and reused by every
-- payment, which is why they belong here and not on the transfer.

-- Company registration number — SSM, UEN, ACRA, DTI, NPWP and so on. One of
-- the R.16 originator identifiers, and the one a business normally has.
ALTER TABLE "organizations" ADD COLUMN "registration_number" text;--> statement-breakpoint

-- Registered address. The other accepted identifier, and what most SEA
-- partners ask for by name.
ALTER TABLE "organizations" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address_city" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address_state" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address_postal_code" text;--> statement-breakpoint
-- ISO 3166-1 alpha-2.
ALTER TABLE "organizations" ADD COLUMN "address_country" text;
