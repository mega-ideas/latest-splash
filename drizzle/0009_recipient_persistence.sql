-- Persist beneficiaries, and make them belong to somebody.
--
-- `suppliers` was built for this record in migration 0006 — legal identity,
-- address, bank routing scheme, screening verdict, the whole FATF R.16 set —
-- and never wired up. The operational beneficiary lived in a process-global JS
-- Map, so every field collected to satisfy the travel rule was discarded on
-- restart, and the record that a partner may ask us to produce for a payment
-- did not outlive a deploy.
--
-- The isolation problem was the more urgent one. The Map carried no org id, and
-- `listRecipients()` returned all of it:
--
--   GET /api/recipients        returned EVERY tenant's beneficiaries — names,
--                              banks, SWIFT codes, account numbers — to any
--                              authenticated caller.
--   DELETE /api/recipients/:id deleted any beneficiary by id, with no check
--                              that it belonged to the caller.
--
-- `suppliers.org_id` is NOT NULL and already indexed, so scoping is a property
-- of the table rather than a filter every read has to remember.

-- 1. Delivery tier decides whether funds are paid out, swept, or held as a
--    stored balance for this beneficiary. Read on the settlement path, so it
--    earns a column rather than a place in the metadata blob.
ALTER TABLE "suppliers" ADD COLUMN "tier" text;--> statement-breakpoint

-- 2. Sweep configuration: venue, destination bank and account, delay. One
--    nested object belonging to one beneficiary, queried by nobody.
ALTER TABLE "suppliers" ADD COLUMN "sweep_config" jsonb;--> statement-breakpoint

-- 3. Seeded demo beneficiaries must be filterable out of anything real.
ALTER TABLE "suppliers" ADD COLUMN "demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- 4. The rest of the operational record — the contact email a KYB invite goes
--    to, whether one was sent, and whether the beneficiary was typed in or
--    created by an invoice link.
ALTER TABLE "suppliers" ADD COLUMN "recipient_metadata" jsonb;--> statement-breakpoint

-- Listing a tenant's beneficiaries newest-first is the only list read there is,
-- and it must never be able to scan another tenant's rows.
CREATE INDEX "suppliers_org_created_idx" ON "suppliers" USING btree ("org_id", "created_at" DESC);
