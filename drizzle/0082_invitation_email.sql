-- The email an invited person gets, and the record that it was sent once (v2 Phase 3, p3-invite-email).
--
-- Sky's decision of 1 Nov: people who are invited also get an email, through Resend. The
-- email is a courtesy; the invitation in the app is the invitation. So the send is recorded
-- ON the invitation and never gates it:
--
--   email_state        NULL         no send has been tried (an invitation from before this
--                                   migration, or one made a moment ago)
--                      'sending'    one send has been claimed and has not reported back
--                      'sent'       the provider accepted it
--                      'failed'     the provider refused it, or could not be reached
--                      'not_configured'  no real mail sender is set up here, so nothing went
--   email_attempts     how many sends were claimed. It is part of the key given to the mail
--                      provider, so a repeat of one send is recognised and a new attempt is not.
--   email_attempt_at   when the latest send was claimed. A claim that never reported back for
--                      a while is treated as unknown, and the owner may send again.
--   email_sent_at      when the provider accepted it.
--   email_message_ref  the provider's message id when it gives one.
--
-- A claim is one UPDATE that moves the state, so two clicks, two owners or a retry cannot both
-- send. There is still no column that could let a link sign anyone in: the link in the email
-- carries only the invitation's id, which grants nothing without signing in as the invited email.

ALTER TABLE "team_invitations" ADD COLUMN IF NOT EXISTS "email_state" text;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN IF NOT EXISTS "email_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN IF NOT EXISTS "email_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN IF NOT EXISTS "email_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN IF NOT EXISTS "email_message_ref" text;
--> statement-breakpoint
ALTER TABLE "team_invitations" DROP CONSTRAINT IF EXISTS "team_invitations_email_state_check";
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_email_state_check" CHECK ("email_state" IS NULL OR "email_state" IN ('sending', 'sent', 'failed', 'not_configured'));
--> statement-breakpoint
ALTER TABLE "team_invitations" DROP CONSTRAINT IF EXISTS "team_invitations_email_sent_consistent";
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_email_sent_consistent" CHECK (("email_state" = 'sent') = ("email_sent_at" IS NOT NULL));
