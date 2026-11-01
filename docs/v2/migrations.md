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
