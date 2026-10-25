-- Get paid (v2 brief 5.8): an invoice is created once.
--
-- The create dialog sends one key per invoice it is creating and keeps it
-- across retries. The key and a fingerprint of the details are kept with the
-- invoice; the index holds one invoice per key per org, so a retry, a double
-- click or two racing requests never make a second invoice and pay link.
-- Invoices made before this have no key and are left alone.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "create_key" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "create_fingerprint" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_org_create_key_unique" ON "invoices" ("org_id", "create_key") WHERE "create_key" IS NOT NULL;
