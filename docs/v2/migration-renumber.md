# Migration numbers on v2/integration

`v2/integration` is Phase 3 (the dashboard) with Phase 4 (the landing) merged in.
This page says what the migration list is, what each kind of existing database
needs, and how that was checked.

## The list

68 migrations, `0000` to `0067`, one journal entry each, `idx` 0 to 67, and the
`when` values rising. `npm run check:migrations` checks names, `idx`, file order
and now `when`.

| Number | Migration | Owner |
| --- | --- | --- |
| 0033 to 0054 | wallet signing through fee withdrawal alerts | Phase 2 |
| 0055 | lost-answer reversal backfill | Phase 2 |
| 0056 | cross-chain batch burn | Phase 2 |
| 0057 | partner account reference unique | Phase 2 |
| 0058 | treasury wallet | Phase 3 |
| 0059 | treasury wallet binding | Phase 3 |
| 0060 | payable invoices | Phase 3 |
| 0061 to 0063 | invoices review, review two, create once | Phase 3 |
| 0064 | transfer payments | Phase 3 |
| 0065 | batch payouts | Phase 3 |
| 0066 | team roles | Phase 3 |
| 0067 | access requests | Phase 4 |

Phase 4's migration was `0033_access_requests` on its own branch, where it was
the only migration after Phase 1's `0032`. It is now `0067_access_requests`,
`idx` 67, with a `when` later than `0066`'s. Its SQL is unchanged.

The SQL of `0058` still says in a comment that it is "numbered 0055". That is
the old number. The comment is left alone: editing an applied file changes its
hash, and the dev database reports a changed file.

## Why `when` matters more than the number

`drizzle-kit migrate`, `npm run db:migrate:run` and the dev database's ledger all
use drizzle's migrator. It does not use the file name or `idx` to decide what to
run. It reads the newest row of `drizzle.__drizzle_migrations` and applies the
journal entries whose `when` is **later than that row's `created_at`**
(`node_modules/drizzle-orm/pg-core/dialect.js`, `migrate()`), in one transaction.
The dev database (`scripts/dev-db-migrations.mjs`) works by file **name** in its
own table `splash_dev_migrations`, and also writes drizzle's ledger.

## A database made on an empty start

Nothing is needed. Checked on `v2/integration`, on an empty PGlite database,
three ways:

- drizzle's own `node-postgres` migrator, over a PGlite socket server: 68 rows in
  the ledger, newest `when` 1794355200000, a second run changes nothing.
- the dev database's runner (`scripts/dev-db-migrations.mjs`): 68 applied, 68
  ledger rows, a second run changes nothing.
- `DEV_DB_PORT=5439 npm run dev:db`: 68 `applied` lines in order, `0067` last,
  the seed ran, no error.

The two runners produce the same tables, columns, indexes and constraints (the
dev runner's own bookkeeping table aside): 96 tables in `public`.

## A database that is at today's numbering, earlier

Nothing is needed beyond running the migrator. Checked:

| The database stops at | What `migrate` applies |
| --- | --- |
| `0057` (Phase 2 tip) | `0058` to `0067`, once each, in order |
| `0066` (Phase 3 tip before this merge) | `0067` |

## A database that applied Phase 3's OLD numbers

Commit `7063677` moved Phase 3's migrations after Phase 2's. Before it, Phase 3
had `0055_treasury_wallet`, `0056_treasury_wallet_binding`,
`0057_payable_invoices`, `0058_invoices_review`, `0059_invoices_review_two` and
`0060_invoices_create_once`, with `when` 1793318400000 to 1793750400000. They are
today's `0058` to `0063`, with the same SQL (the rename changed names, `idx` and
`when`).

Such a database is a development or review database that ran Phase 3 before
Phase 2's `0055` to `0057` existed on that branch. It has `0000` to `0054`, then
the six above, and its newest ledger row is 1793750400000. Tell it from a
database that applied today's `0055` to `0060`: the old one has
`treasury_wallet_orders` but not the index
`partner_deposit_addresses_account_ref_unique` (that is `0057`).

### With drizzle (`db:migrate`, `db:migrate:run`): not safe as it stands

Running migrate on it does not fail. It does the wrong thing quietly:

1. **Phase 2's `0055`, `0056` and `0057` are skipped for ever.** Their `when`
   values (1793318400000, 1793404800000, 1793491200000) are earlier than the
   newest ledger row, so drizzle treats them as applied. Nothing says so. The
   database keeps `cross_chain_transfers_burn_unique` (so a second receipt for
   the same burn digest, which a batch of cross-chain payments makes, is
   refused), has no `partner_deposit_addresses_account_ref_unique` (so two
   businesses can hold one partner account reference), and the lost-answer
   backfill never runs.
2. `0058`, `0059` and `0060` are skipped, correctly: that SQL is already in the
   database under the old names. Nothing is lost; `0059`'s `DELETE FROM
   treasury_wallet_orders` does not run.
3. `0061`, `0062` and `0063` run a second time. Their SQL is `IF NOT EXISTS`
   throughout, so this changes nothing. Their ledger rows are the first new ones.
4. `0064` to `0067` run once.

Result of the test: ledger 61 rows, then 68 (seven added: `0061` to `0067`), the
treasury order row kept, and the missing pieces of (1) still missing.

**What it needs**: apply Phase 2's three files by hand **before** migrate. All
three are safe to run once on this database and again later (`IF NOT EXISTS`,
`DROP ... IF EXISTS`, and a backfill that touches a row only while its counter is
0). The `--> statement-breakpoint` lines are SQL comments, so `psql` runs the
files as they are.

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f drizzle/0055_lost_answer_reversal_backfill.sql \
  -f drizzle/0056_cross_chain_batch_burn.sql \
  -f drizzle/0057_partner_account_ref_unique.sql
npm run db:migrate:run
```

`0057` fails if two live partner deposit addresses share one account reference.
Revoke the wrong one as staff and run it again; its own comment says so.

Result of the test: ledger 68 rows, `cross_chain_transfers_burn_unique` gone, the
account reference index present, the treasury order kept, a further migrate a
no-op. The ledger then holds old rows for the old `when` values and new ones for
`0061` to `0067`; the count (68) equals the file count.

If the database holds nothing that matters, the simpler answer is a fresh one:
run `db:migrate:run` on an empty database.

### With the dev database (`npm run dev:db` with `DEV_DB_DIR`): it stops

The dev database keys on the file name. The new names are not in
`splash_dev_migrations`, so `0055` to `0058` run (harmless), and then
`0059_treasury_wallet_binding` runs on a database that already has its columns:

```
0059_treasury_wallet_binding.sql failed: column "source_address" of relation
"treasury_wallet_orders" already exists
```

The dev database prints "may be half-migrated. Delete it and start again" and
exits. Two ways out:

- Delete the directory named by `DEV_DB_DIR` (and the `.lock` beside it) and start
  again. The seed runs again; nothing in a dev database is worth keeping.
- To keep the data, rename the six recorded names to today's, then start. Stop
  `dev:db` first.

  ```sql
  UPDATE splash_dev_migrations SET name = '0063_invoices_create_once.sql'   WHERE name = '0060_invoices_create_once.sql';
  UPDATE splash_dev_migrations SET name = '0062_invoices_review_two.sql'    WHERE name = '0059_invoices_review_two.sql';
  UPDATE splash_dev_migrations SET name = '0061_invoices_review.sql'        WHERE name = '0058_invoices_review.sql';
  UPDATE splash_dev_migrations SET name = '0060_payable_invoices.sql'       WHERE name = '0057_payable_invoices.sql';
  UPDATE splash_dev_migrations SET name = '0059_treasury_wallet_binding.sql' WHERE name = '0056_treasury_wallet_binding.sql';
  UPDATE splash_dev_migrations SET name = '0058_treasury_wallet.sql'        WHERE name = '0055_treasury_wallet.sql';
  ```

  The next start applies `0055`, `0056`, `0057` and `0064` to `0067`, nothing
  twice. Result of the test: 61 already applied, 7 new, the treasury order kept,
  `cross_chain_transfers_burn_unique` gone.

## How this was checked

On this branch, with PGlite 0.5 and drizzle-orm 0.45.2: the old database was built
from the tree's own files (journal entries `0000` to `0054`, then the six old
names with their old `when` values and the SQL of today's `0058` to `0063`),
migrated with drizzle's real `node-postgres` migrator against a PGlite socket
server, given a treasury order row, and then migrated again with today's
`drizzle/` folder. The dev database case used the dev runner on the same two
folders. The scripts are scratch files, not part of the repository.

`tests/migration-journal-order.test.mjs` keeps the one rule that would have
caught this at review: `when` rises with the number.
