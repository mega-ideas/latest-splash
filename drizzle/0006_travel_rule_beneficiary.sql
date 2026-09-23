-- Travel-rule beneficiary data (FATF Recommendation 16) and per-payment
-- compliance context.
--
-- Before this, a beneficiary was a name, a country, a bank name, an optional
-- SWIFT and an account reference. That is enough to render a row and not enough
-- to pay anyone: PH clears on a bank code through PESONet/InstaPay, the EU and
-- UK on IBAN, GB domestic on a sort code, and most of ASEAN on SWIFT plus a
-- local account number. Partners ask for the rest during onboarding, and R.16
-- requires the originator and beneficiary data to travel WITH the transfer.
--
-- Every column is nullable. Existing rows predate them, and what is REQUIRED
-- differs by destination country — that is enforced in
-- lib/compliance/travel-rule.ts at the point a payment is authorized, where the
-- corridor is known, rather than by a column definition that cannot know it.

CREATE TYPE "beneficiary_type" AS ENUM('INDIVIDUAL', 'BUSINESS');--> statement-breakpoint
CREATE TYPE "bank_id_scheme" AS ENUM('SWIFT_BIC', 'IBAN', 'LOCAL_BANK_CODE', 'GB_SORT_CODE', 'US_ROUTING_ABA', 'AU_BSB', 'IN_IFSC', 'PROXY_ID');--> statement-breakpoint

-- ── Beneficiary: legal identity ──────────────────────────────────────────────
ALTER TABLE "suppliers" ADD COLUMN "beneficiary_type" "beneficiary_type";--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "registration_number" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "date_of_birth" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "national_id_number" text;--> statement-breakpoint

-- ── Beneficiary: address (an R.16 identifier in its own right) ───────────────
ALTER TABLE "suppliers" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "address_city" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "address_state" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "address_postal_code" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "address_country" text;--> statement-breakpoint

-- ── Beneficiary: bank routing ────────────────────────────────────────────────
ALTER TABLE "suppliers" ADD COLUMN "bank_id_scheme" "bank_id_scheme";--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "bank_id_value" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "bank_branch_code" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "bank_country" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "bank_account_number" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "bank_account_name" text;--> statement-breakpoint

-- ── Beneficiary: last screening verdict (KYT) ────────────────────────────────
ALTER TABLE "suppliers" ADD COLUMN "screening_verdict" "screening_verdict";--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "screened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "screening_reference" text;--> statement-breakpoint
CREATE INDEX "suppliers_screening_idx" ON "suppliers" USING btree ("screening_verdict");--> statement-breakpoint

-- ── Payment: the context that belongs to the payment, not the beneficiary ────
-- The same supplier is paid for different reasons, so purpose and source of
-- funds are per-payment. `travel_rule_snapshot` freezes what actually travelled
-- with this transfer: a beneficiary edited next week must not change the record
-- of what this payment carried.
ALTER TABLE "payment_intents" ADD COLUMN "purpose_code" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "purpose_description" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "source_of_funds" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "beneficiary_relationship" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "travel_rule_snapshot" jsonb;
