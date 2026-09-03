CREATE TABLE "product_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"org_hash" text NOT NULL,
	"actor_hash" text,
	"subject_hash" text,
	"corridor" text,
	"amount_minor" bigint,
	"currency" text,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "product_events_name_occurred_idx" ON "product_events" USING btree ("name","occurred_at");--> statement-breakpoint
CREATE INDEX "product_events_org_occurred_idx" ON "product_events" USING btree ("org_hash","occurred_at");