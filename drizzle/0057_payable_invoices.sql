-- Pay invoices (v2 brief 5.8): the invoices a business's suppliers send it.
--
-- One row per supplier invoice. Intake stores what was read and how sure the
-- reading is; a person confirms the fields, matches a verified recipient and
-- schedules it; the payment flow (brief 5.4) records its intent, then the Sui
-- digest it settled with. lib/server/bills-store.ts is the only writer.
--
-- The database holds the rules a race could break:
--   - one intake per client key (the idempotency key), per org;
--   - the same document cannot be open twice in one org (cancelled ones aside);
--   - the same supplier's invoice number cannot be scheduled, waiting for
--     approval or paid twice in one org: the duplicate that would pay twice;
--   - one invoice per payment intent and per Sui transaction;
--   - a scheduled, approving or paid invoice has confirmed fields, a
--     recipient and a date; an approving one has an intent; a paid one has an
--     intent and a digest; only a paid one has a self-billed e-invoice.
CREATE TABLE IF NOT EXISTS "payable_invoices" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "intake_key" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('review', 'scheduled', 'approving', 'paid', 'cancelled')),
  "document_name" text,
  "document_sha256" text NOT NULL CHECK ("document_sha256" ~ '^[0-9a-f]{64}$'),
  "document_text" text,
  "extraction" jsonb NOT NULL,
  "payee_name" text,
  "payee_key" text,
  "invoice_number" text,
  "invoice_number_key" text,
  "amount_minor" bigint CHECK ("amount_minor" IS NULL OR "amount_minor" > 0),
  "currency" text,
  "due_date" text,
  "invoice_date" text,
  "payee_country" text,
  "confirmed_by" text,
  "confirmed_at" timestamp with time zone,
  "duplicate_ack_by" text,
  "duplicate_ack_reason" text,
  "duplicate_ack_at" timestamp with time zone,
  "recipient_id" text,
  "matched_by" text,
  "matched_at" timestamp with time zone,
  "scheduled_for" text,
  "scheduled_by" text,
  "scheduled_at" timestamp with time zone,
  "payment_intent_id" text,
  "approval_requested_by" text,
  "approval_requested_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "sui_digest" text,
  "receipt_no" text,
  "approvers" jsonb,
  "myinvois" jsonb,
  "myinvois_sha256" text,
  "myinvois_generated_at" timestamp with time zone,
  "myinvois_generated_by" text,
  "history" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payable_invoices_ready_to_pay" CHECK (
    "status" NOT IN ('scheduled', 'approving', 'paid')
    OR ("confirmed_at" IS NOT NULL AND "amount_minor" IS NOT NULL AND "currency" IS NOT NULL
        AND "recipient_id" IS NOT NULL AND "scheduled_for" IS NOT NULL
        AND "payee_key" IS NOT NULL AND "invoice_number_key" IS NOT NULL)
  ),
  CONSTRAINT "payable_invoices_approving_has_intent" CHECK ("status" NOT IN ('approving', 'paid') OR "payment_intent_id" IS NOT NULL),
  CONSTRAINT "payable_invoices_paid_has_digest" CHECK ("status" <> 'paid' OR ("sui_digest" IS NOT NULL AND "paid_at" IS NOT NULL)),
  CONSTRAINT "payable_invoices_einvoice_only_when_paid" CHECK ("myinvois" IS NULL OR "status" = 'paid')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payable_invoices_org_intake_unique" ON "payable_invoices" ("org_id", "intake_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payable_invoices_org_created_idx" ON "payable_invoices" ("org_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payable_invoices_payment_intent_unique" ON "payable_invoices" ("payment_intent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payable_invoices_sui_digest_unique" ON "payable_invoices" ("sui_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payable_invoices_open_document_unique" ON "payable_invoices" ("org_id", "document_sha256") WHERE "status" <> 'cancelled';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payable_invoices_number_once_unique" ON "payable_invoices" ("org_id", "payee_key", "invoice_number_key") WHERE "status" IN ('scheduled', 'approving', 'paid');
