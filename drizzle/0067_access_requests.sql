-- Requests for pilot access to routes that are not live yet (v2 brief D16):
-- Malaysia, Vietnam, Thailand and Singapore, captured by the landing
-- calculator. Public input: one row per email and route, so asking again
-- changes nothing, and the currency is one of the four pilot routes.

CREATE TABLE IF NOT EXISTS "access_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL CHECK (char_length("email") <= 254),
  "company" text NOT NULL CHECK (char_length("company") BETWEEN 2 AND 160),
  "currency" text NOT NULL CHECK ("currency" IN ('MYR', 'VND', 'THB', 'SGD')),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "access_requests_email_currency_unique" UNIQUE ("email", "currency")
);
--> statement-breakpoint
-- Staff read them newest first.
CREATE INDEX IF NOT EXISTS "access_requests_created_idx" ON "access_requests" ("created_at");
