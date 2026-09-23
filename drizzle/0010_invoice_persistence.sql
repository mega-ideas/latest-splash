-- Persist invoices, and make them belong to somebody.
--
-- `invoices` has had org_id NOT NULL, a supplier reference, bigint minor units
-- and a unique pay-link slug since migration 0000. The operational invoice
-- lived in a process-global JS Map with none of that, and every route read it
-- by id alone:
--
--   GET   /api/invoices       every tenant's invoices to any authenticated
--                             caller — amounts, payers, memos, due dates.
--   GET   /api/invoices/:id   any invoice by id.
--   PATCH /api/invoices/:id   any tenant's invoice MODIFIED by id: status,
--                             payment reference, the transfer it binds to.
--                             Write access across the tenant boundary.
--   /api/copilot/summary      the assistant's "your invoices" was everyone's,
--   /api/copilot/suggest      so 0xWal would describe one customer's overdue
--                             invoices to another.
--
-- Four columns are missing from the table, all of them facts the operational
-- record already carries.

-- 1. The reference a payer quotes on the wire. Without it a bank credit cannot
--    be matched back to the invoice it settles.
ALTER TABLE "invoices" ADD COLUMN "payment_reference" text;--> statement-breakpoint

-- 2. The hash of the uploaded document. `walrus_blob_id` says where it is;
--    this says what it was, so tampering is detectable without fetching it.
ALTER TABLE "invoices" ADD COLUMN "document_sha256" text;--> statement-breakpoint

-- 3. The transfer that settles this invoice. The link exists in the other
--    direction already (`payment_intents.invoice_id`); an invoice that cannot
--    name its own settlement forces a scan to answer "was this paid".
ALTER TABLE "invoices" ADD COLUMN "transfer_intent_id" text;--> statement-breakpoint

-- 4. Seeded demo invoices must be filterable out of anything real.
ALTER TABLE "invoices" ADD COLUMN "demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Listing a tenant's invoices newest-first is the dashboard's main read, and it
-- must never be able to scan another tenant's rows.
CREATE INDEX "invoices_org_created_idx" ON "invoices" USING btree ("org_id", "created_at" DESC);
