# Database migrations

Migrations are applied in journal order on an empty or current database.

The journal is `drizzle/meta/_journal.json`. Each entry has an `idx`, a `tag`
(the file name without `.sql`) and a `when` time. A migration file that is not
in the journal is never applied, and an entry whose `when` is not later than
the one before it is skipped by a database that already applied the earlier
one. `npm run check:migrations` (part of `npm run lint`) fails on both, and on a
journal that is out of order.

Rules that follow from that:

- A new migration takes the next number and the next `when`. An applied
  migration is never edited; a later one changes what it made.
- A migration that drops something says so by name and does not use `CASCADE`,
  so nothing else goes with it, and it can run twice (`IF EXISTS`).
- The local development database applies the same files in the same order and
  records each one, so a second start applies nothing.

## `0071_drop_batch_runs`

`0071` drops `batch_runs`, the table the removed v1 custody payout route wrote.
The rows in it, if any, are not copied anywhere. That route was refused on
mainnet in every mode, so a mainnet database should hold none. Before applying
`0071` to a shared database (testnet, staging), run

```sql
select count(*) from batch_runs;
```

and export the rows first if the count is not zero. A business's batch payout
history is `wallet_batches`, which stays.

## `0072_retire_batch_payout_proposals`

`0072` closes the proposals of kind `BATCH_PAYOUT` that are still open (drafted,
simulated, waiting for approval, approved, signed or submitted): each becomes
`EXPIRED` with `execution_state` `SKIPPED` and the reason on the row. Settled,
anchored, rejected, failed, expired and reversed ones, and every other kind, are
left as they are. Nothing is dropped or deleted, and a second run changes nothing.
Before applying it to a shared database, see what it will touch:

```sql
select status, count(*) from proposals where kind = 'BATCH_PAYOUT' group by status;
```

The code no longer has the kind (docs/v2/phase3-zeke-batches.md); a payout run is
made from a sheet in the wallet batch flow.

## `0077_pay_exchange_alone`

Adds the access kind `pay_exchange_alone` to `wallet_member_access` (the check
constraint is dropped and re-added with the third kind) and a new table,
`wallet_transfer_disclosures`, with a trigger that refuses any rewrite except
setting the signing request id once. It inserts nothing: no existing member is
given the switch. Safe to run again.

## `0080_drop_unused_tables`

`0080` drops six tables that nothing reads and nothing writes: `funding_events`,
`treasury_moves`, `compliance_cases`, `screening_results`, `audit_anchors` and
`login_attempts`. Dropping loses the rows; they are not copied anywhere. Each
statement is `DROP TABLE IF EXISTS` with no `CASCADE`, so it is safe on a
database that never had a table, a second run changes nothing, and no other
table goes with them (none has a foreign key to them). The `screening_verdict`
type stays; `suppliers.screening_verdict` uses it.

Before applying `0080` to a shared database (testnet, staging, production), read
how many rows each holds:

```sql
select count(*) from funding_events;
select count(*) from treasury_moves;
select count(*) from compliance_cases;
select count(*) from screening_results;
select count(*) from audit_anchors;
select count(*) from login_attempts;
```

On a database that never had one of these tables, its count answers with
`relation "<table>" does not exist`. That is not a fault: the table is already
absent, there is nothing to lose, and the migration still applies (its
`DROP TABLE IF EXISTS` skips it). To check without an error, run
`select to_regclass('public.<table>');` first; it returns null when the table
is absent.

A count above zero is a reason to stop and ask: export those rows first, or
confirm they are test data. `login_attempts` may hold old failed-login rows from
before the limiter moved to `rate_limit_hits`; they have no use now. A
recipient's screening verdict is `suppliers.screening_verdict`, the daily audit
batch is `daily_audit_batches` and the on-chain anchor is the `audit_anchor`
object, none of which this touches.

One more table, `payouts` (made by `0000`, with a foreign key to
`payment_intents`), has no reader and no writer either, and it is kept: `0080`
leaves it in place until Sky decides whether to drop it. Nothing in the code
imports it, uses `schema.payouts`, or names it in SQL.

## `0081_decliner_snapshot`

`0081` adds four nullable text columns: `declined_name` and `declined_title` on
`wallet_signing_signers`, and `decided_name` and `decided_title` on
`wallet_approval_asks`. They hold the name and the title of the person who
declined, as they were then, so "Declined by Aisha (CFO)" does not change when
she leaves or is renamed. No existing row is rewritten: a decline made before
`0081` has nulls and is read from the person's live name and title while they
are still a member.

It also drops one foreign key, by name and `IF EXISTS`:
`wallet_signing_signers_user_id_fkey`, which deleted the signer row (the record
that a person declined, with the snapshot) when the account was deleted. The
column and its place in the primary key stay. Nothing else is dropped and no
`CASCADE` is used. Safe to run again.

## `0083_member_title`

`0083` adds one nullable text column, `memberships.title`: a member's job title
(for example CFO, Finance lead, Operations), plain words, at most 40 characters,
**empty for everyone** after the migration (no row is touched, nobody is given a
title). Empty means the role word is the title, as before. A CHECK
(`memberships_title_length`) refuses more than 40 characters, as a backstop to
the cleaning the app does before it writes.

It also adds `member_title_changed` to the audit trail's allowed actions. A CHECK
cannot be extended, so `wallet_authority_events_action_check` is dropped and added
again **with every value `0079` listed plus the new one** (a shorter list would
refuse lines already written; `tests/member-title.test.mjs` compares the two
lists). Safe to run again; nothing is dropped but those two constraints, by name
and `IF EXISTS`.

## `0084_exchange_name_sharing`

`0084` adds two boolean columns, both `NOT NULL DEFAULT true`: `organizations.share_names_with_exchange`
(the business's choice, owners only) and `memberships.share_name_with_exchange` (the person's own). Every
business and every member starts with sharing **on**, which is what the Travel Rule message did before (it
named the person), and no row is rewritten. If either is off, the message to the exchange reads "Sent by
COMPANY NAME" and carries no person's name or title.

It also adds `exchange_name_sharing_changed` to the audit trail's allowed actions. A CHECK cannot be
extended, so `wallet_authority_events_action_check` is dropped and added again **with every value `0083`
listed plus the new one** (`tests/exchange-names.test.mjs` compares the two lists). Safe to run again;
nothing is dropped but that constraint, by name and `IF EXISTS`.

## `0085_payment_trail`

`0085` adds two nullable text columns to `wallet_transfers` (`record_hash`, `record_blob_id`: the hash and
the Walrus blob id of the payment's own sealed record, kept so decision records can name it; existing rows
stay empty) and a new table, `payment_trail_events`: one row per signature, decline or owner's answer to an
ask, holding internal ids, roles, times and hashes only (no name in plain text), unique per payment, person
and kind, with a trigger that refuses any rewrite except sealing a row once. It inserts nothing. Safe to run
again (`IF NOT EXISTS`, `OR REPLACE`).

## `0086_limit_starts_and_two_approvals`

How a business's limits start, and two people for a large grant (docs/v2/phase3-limits.md).

- **Nothing existing is lowered or changed.** It writes one `business_limits` row for every
  business and every limit that has none, at the figure the business runs on today: 2,000 USDC a
  payment, 5,000 a day, 20,000 a month and 90 days (source `raised`, `changed_by`
  `system:migration`, `held_max` equal to the value), with one `limit_change_applied` line each
  on the trail whose `before` and `after` are the same figure. A row already there (migration 0079,
  or a limit an owner lowered) is kept as it is (`ON CONFLICT DO NOTHING`). Before applying it to a
  shared database, see how many rows it will write:

  ```sql
  select count(*) * 4 - (select count(*) from business_limits) as rows_to_write from organizations;
  ```

  Running its pinning statement again writes nothing more. After it, a business made later has no
  rows and starts at the new figures (50,000 a payment, 100,000 a day, 500,000 a month, 90 days) or
  at its own answers.
- A new table, `business_limit_answers` (one row per business: the three answers as written, at
  most 40 characters each, what was read from them, the proposal and what the working asked for
  beyond the starting figures, a version, and `applied_at`). It inserts nothing.
- `business_limits.source` gains `starting`: the CHECK is dropped and added again with the four values
  (`raised`, `lowered`, `restored`, `starting`).
- `business_limit_requests` gains `first_approved_by`, `first_approver_role`, `first_approved_at`,
  `first_granted_value` and `decided_role`, and four CHECKs that hold the two-person rule in the
  database: the first-approval columns are all set or all null; an approved or applied request has a
  second approver who is not the first (case-insensitive) and whose role is the other of
  compliance and operations; and a daily grant above 250,000 USDC or a monthly grant above
  2,500,000 USDC cannot be approved or applied without a first approver. The two amounts repeat
  `LARGE_GRANT_LINES` in `lib/limits/rules.ts` as USDC minor units and move with it in a later
  migration. No existing row can violate them (the old ceilings were 50,000 and 500,000).
- The trail's allowed actions: `wallet_authority_events_action_check` is dropped and added again
  **with every value `0084` listed plus the two new ones** (`limit_answers_saved`,
  `limit_request_first_approved`). Nothing else is dropped, by name and `IF EXISTS`.


## `0087_approval_wait_ladder`

When nobody who can approve answers (docs/v2/phase3-team-roles.md, "When nobody who can approve answers").

- **Nothing existing is changed and nothing is inserted.** Two new tables, safe to run again (`IF NOT EXISTS`).
  `approval_wait_steps` has one row per (kind of request, request id, step): the primary key is the "once", and the steps are
  `asked`, `reminder_10m`, `reminder_1h`, `reminder_4h`, `lapsed` and `manual_N` (a "Remind them now"). `approval_notices`
  has one row per person told at a step (unique on kind, request id, step and person; a foreign key to the step), holding
  words, the signed-in page it links to and the state of its e-mail. No amount, payee, address or secret is stored in either.
- **The trail's allowed actions:** `wallet_authority_events_action_check` is dropped and added again **with every value `0086`
  listed plus the two new ones** (`approval_lapsed`, `approval_reminded`). Nothing else is dropped, by name and `IF EXISTS`.
- Nothing in it needs the cron to run first: with no rows the ladder simply starts from the next pass. The first pass after it
  is applied tells the approvers of every request that is still collecting (step "asked", then only the latest due step on
  later passes), so a deploy during a busy hour sends one notice per waiting request and not a backlog.
