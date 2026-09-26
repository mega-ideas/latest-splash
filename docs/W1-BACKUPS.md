# W1 — Backups & restore drill (DigitalOcean Managed PostgreSQL)

Host decision (0xSky, 2026-07-18): **DigitalOcean Managed PostgreSQL** — the
project already runs on DO.

## What the managed cluster gives us

- **Daily automated backups**, retained 7 days, no configuration required.
- **Point-in-time recovery (PITR)** via continuous WAL archiving: restore to
  any second within the retention window.
- Restores always create a **new cluster** (fork) — the original is never
  overwritten, which makes the drill safe to run against production.

## Setup checklist (once the cluster exists)

1. Create the cluster (smallest tier is fine pre-launch; PG 16).
2. Add the app as a **trusted source** (App Platform app or droplet) so the
   DB is not open to the internet.
3. Create a restricted `splash_app` role — the `doadmin` superuser stays out
   of `DATABASE_URL`.
4. Put the connection string in `.env.local` / the deployment env as
   `DATABASE_URL`. Never commit it. Do not keep DigitalOcean's
   `?sslmode=require` ending: `pg` 8 then verifies against Node's trusted CAs
   and fails on DigitalOcean's own CA. Download the cluster's CA certificate
   and end the string with
   `?sslmode=verify-full&sslrootcert=<path to the CA file>`
   (`docs/DEPLOY-DIGITALOCEAN.md`, checklist item 4, TLS).
5. Run `npm run db:migrate:run` to apply the checked-in migrations in
   `drizzle/`. Not `npm run db:migrate`: `drizzle-kit migrate` needs a TTY,
   and run headless it applies nothing and exits 0.

## Restore drill (run once, record evidence — W1 acceptance)

1. Note the current time T and write a marker row:
   `insert into webhook_events (id, provider, event_id, payload) values ('drill-<date>','DRILL','drill-<date>','{}');`
2. In the DO console: **Databases → cluster → Backups → Restore** — choose
   "point in time", pick T+1 minute, restore to a NEW cluster.
3. Connect to the forked cluster; verify the marker row exists and the
   ledger invariant holds on it. `npm run test:db` does not help here: it
   runs against in-memory PGlite and never reads `DATABASE_URL`. Run the
   invariant query directly, which must return no rows:
   `select journal_id, currency from ledger_postings group by journal_id, currency having sum(amount_minor) <> 0;`
4. Record: restore start/end wall-clock, fork cluster name, verification
   output. Commit the notes to this file under a dated "Drill log" heading,
   and tick the restore-drill line in `docs/MAINNET-CHECKLIST.md`.
5. Destroy the fork.

## Invariants in CI

`npm run test:db` applies the checked-in migration SQL to an in-memory
Postgres (pglite) and asserts:
- every money column is `bigint` minor units,
- `postJournal` rejects unbalanced postings before any write,
- `findUnbalancedJournals` (Σ postings = 0 per journal/currency) is empty,
- webhook `(provider, event_id)` uniqueness rejects replays at the schema level.
