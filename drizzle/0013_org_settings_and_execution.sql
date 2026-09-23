-- Make human approval real: it cannot be switched off by anyone, and when it
-- is given it makes the payment happen.
--
-- Two defects, and each one on its own makes the other pointless.
--
-- ── 1. The approval control was globally switchable by any signed-in user ───
--
-- `readOperatingSettings()` read ONE JSON file — data/operating-settings.json
-- — with no org id in it, and `PUT /api/settings` was guarded by
-- `requireCustomerRequest` and nothing else. No role check, no org scoping.
--
-- So any authenticated user of any tenant could set `requireDualApproval` to
-- false and drop `approvalThresholdUsd`, for EVERY tenant at once. The
-- maker-checker control, the per-transfer ceiling and the daily ceiling all
-- read that file. A control a payer can disable is not a control.
--
-- Settings become per-org rows here, and the route gains a role check.
--
-- ── 2. An approved payment never actually happened ─────────────────────────
--
-- The proposal state machine ends a successful approval at SUBMITTED
-- (lib/queue/proposal-state.ts). Nothing dispatched SETTLE, and the payload a
-- payment would be rebuilt from lived in a `Map` on `globalThis` with exactly
-- one reference in the whole repository: its own definition.
--
-- So the full maker-checker path — propose, notify, approve, co-approve —
-- terminated in a row marked SUBMITTED and no money moved. Worse than no
-- approval flow, because everyone involved believes the payment went.
--
-- The payload moves onto the proposal row so an approval that outlives a
-- restart can still be executed, and so the thing approved and the thing
-- executed are one record rather than two that can drift.

CREATE TABLE "org_settings" (
  "org_id" text PRIMARY KEY NOT NULL,
  -- Whole USD, matching the operator-facing numbers in Settings. Kept as
  -- integers rather than the micro-unit bigints used on the money path: these
  -- are policy dials a human types, not amounts that get multiplied.
  "per_transfer_limit_usd" integer DEFAULT 50000 NOT NULL,
  "daily_limit_usd" integer DEFAULT 250000 NOT NULL,
  "approval_threshold_usd" integer DEFAULT 10000 NOT NULL,
  "auto_allocate_treasury_pct" integer DEFAULT 1 NOT NULL,
  "require_totp" boolean DEFAULT true NOT NULL,
  "require_dual_approval" boolean DEFAULT true NOT NULL,
  "block_high_risk_corridors" boolean DEFAULT true NOT NULL,
  "notify_on_settlement" boolean DEFAULT true NOT NULL,
  -- How an approver is asked to approve. 'code' sends a one-time code the
  -- approver types back into Splash, which needs the phone AND a live
  -- authenticated session; 'reply' accepts APPROVE/REJECT in the chat itself,
  -- which authenticates a handset rather than a person. Default is the
  -- stronger one.
  "approval_channel" text DEFAULT 'code' NOT NULL,
  "whatsapp_enabled" boolean DEFAULT false NOT NULL,
  -- Who changed it last. A limit that moved without a name attached is a limit
  -- nobody can ask about.
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The payment an approved proposal rebuilds into. On the row, not in a process
-- map: an approval that survives a restart must still be executable, and the
-- thing approved and the thing executed must be one record.
ALTER TABLE "proposals" ADD COLUMN "execution_payload" jsonb;--> statement-breakpoint

-- What happened when it was executed, and when. Distinct from `settlement`,
-- which holds the chain result: this records the attempt, including a failure,
-- so an approval that could not be carried out is visible rather than silent.
ALTER TABLE "proposals" ADD COLUMN "execution_state" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "execution_error" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "executed_at" timestamp with time zone;--> statement-breakpoint

-- An approver's WhatsApp number, bound to a user identity.
--
-- A phone number is not an identity: WhatsApp authenticates a handset, and a
-- reply proves possession of a device rather than the intent of a person. So a
-- reply is only ever accepted when its number resolves to a row here, and the
-- approval is recorded against that USER — never against the number.
CREATE TABLE "approver_channels" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  -- E.164, normalised on write.
  "whatsapp_e164" text,
  -- Proven by a round trip before it may approve anything. An unverified
  -- number is a number somebody typed, and typos route approvals to strangers.
  "verified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "approver_channels" ADD CONSTRAINT "approver_channels_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_channels" ADD CONSTRAINT "approver_channels_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- One channel row per user per org.
CREATE UNIQUE INDEX "approver_channels_user_org_unique" ON "approver_channels" USING btree ("org_id", "user_id");--> statement-breakpoint

-- And one number belongs to one person. Two approvers sharing a handset would
-- make "two approvers agreed" mean one person pressed a button twice.
CREATE UNIQUE INDEX "approver_channels_number_unique" ON "approver_channels" USING btree ("whatsapp_e164");
