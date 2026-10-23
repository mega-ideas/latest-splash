-- Support tickets and their replies, out of `lib/server/support.ts` and into the database.
--
-- The tickets lived in a `Map` on `globalThis`. On serverless every instance had
-- its own copy: a ticket raised on one instance was unknown to the instance the
-- staff console reached, and a cold start lost every ticket and every reply.
--
-- WS2 scoped the store by org (customer calls take the session's org first,
-- staff reach across tenants through `*ForStaff`). `org_id` is NOT NULL with a
-- foreign key to `organizations` on both tables, so a ticket or a reply with
-- no owner cannot exist, and a reply carries its ticket's org.

CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "type" text NOT NULL CHECK ("type" IN ('bug', 'feature', 'complaint', 'other')),
  "subject" text NOT NULL,
  "message" text NOT NULL,
  "email" text,
  "status" text NOT NULL DEFAULT 'OPEN'
    CHECK ("status" IN ('OPEN', 'IN_REVIEW', 'REPLIED', 'CLOSED')),
  "priority" text NOT NULL DEFAULT 'NORMAL' CHECK ("priority" IN ('NORMAL', 'HIGH')),
  "assigned_to" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- A customer lists one org's tickets, most recently touched first.
CREATE INDEX IF NOT EXISTS "support_tickets_org_updated_idx" ON "support_tickets" ("org_id", "updated_at");
--> statement-breakpoint
-- The staff console lists every tenant's tickets the same way.
CREATE INDEX IF NOT EXISTS "support_tickets_updated_idx" ON "support_tickets" ("updated_at");
--> statement-breakpoint
-- Replies are rows, not an array on the ticket: rewriting the array on every
-- reply is a read-modify-write that drops one of two replies sent together.
-- `seq` keeps them in order even when two share a millisecond.
CREATE TABLE IF NOT EXISTS "support_ticket_replies" (
  "id" text PRIMARY KEY NOT NULL,
  "seq" bigserial NOT NULL,
  "ticket_id" text NOT NULL REFERENCES "support_tickets"("id"),
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "actor" text NOT NULL,
  "actor_type" text NOT NULL CHECK ("actor_type" IN ('customer', 'staff')),
  "message" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_ticket_replies_ticket_idx" ON "support_ticket_replies" ("ticket_id", "seq");
