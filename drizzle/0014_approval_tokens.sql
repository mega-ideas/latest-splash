-- One approver, one proposal, one chance.
--
-- An approval request goes out to two or three approvers. Each gets a token
-- that is theirs alone: bound to one proposal AND one user, single-use, and
-- short-lived.
--
-- Why per-approver rather than one code per proposal: unanimous consent means
-- N distinct people must each act. A single shared code makes "three approvers
-- agreed" satisfiable by one person who received it and entered it three
-- times, which is precisely the control being claimed and precisely what it
-- would not be delivering.
--
-- Why it expires: an approval request is a claim about the world at a moment —
-- this balance, this corridor, this beneficiary. A code that still works next
-- week approves a payment nobody re-examined.
--
-- Why `decided_at` and `decision` live here rather than only on `approvals`:
-- a REJECTION is not an approval and has no row there, but it is the most
-- important thing that can come back, and it has to be recorded and terminal.

CREATE TABLE "approval_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "proposal_id" text NOT NULL,
  "org_id" text NOT NULL,
  -- The approver this token belongs to. A token that arrives from anyone else
  -- is refused: it is not a shared secret, it is one person's ballot.
  "user_id" text NOT NULL,
  -- The digits an approver types back into Splash in 'code' mode. Short enough
  -- to read off a phone, and single-use, which is what makes short safe.
  "code" text NOT NULL,
  "channel" text DEFAULT 'code' NOT NULL,
  -- Where it was sent, recorded so "who was asked" has an answer later.
  "sent_to" text,
  "sent_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  -- APPROVE or REJECT. Null until they answer.
  "decision" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "approval_tokens" ADD CONSTRAINT "approval_tokens_proposal_id_proposals_id_fk"
  FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_tokens" ADD CONSTRAINT "approval_tokens_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_tokens" ADD CONSTRAINT "approval_tokens_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- One ballot per approver per proposal. Without this a retry of the
-- notification would mint a second token for the same person, and two live
-- tokens for one approver is one person able to answer twice.
CREATE UNIQUE INDEX "approval_tokens_proposal_user_unique"
  ON "approval_tokens" USING btree ("proposal_id", "user_id");--> statement-breakpoint

-- The lookup an inbound reply performs: find this person's live token.
CREATE INDEX "approval_tokens_user_idx" ON "approval_tokens" USING btree ("user_id", "decided_at");--> statement-breakpoint

-- And the lookup a typed code performs. Not unique on `code` alone — two
-- different approvers may be issued the same digits, and the pair is what
-- identifies a ballot.
CREATE INDEX "approval_tokens_code_idx" ON "approval_tokens" USING btree ("code");
