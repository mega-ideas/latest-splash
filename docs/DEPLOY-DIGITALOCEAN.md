# Deploying Splash to DigitalOcean

Two supported paths. **App Platform** (Option A) is the least work and is
recommended; a **Droplet** (Option B) gives you full control and is cheaper at
steady load. Both build from the GitHub repos this project pushes to
(`sky9484/phase1` / `mega-ideas/latest-splash`).

Upgrading a deployment built before September 2026? Read
[Upgrading an older deployment](#upgrading-an-older-deployment) first — the
new build refuses to install or start on the old runtime and environment.

---

## Before either path — one-time checklist

1. **Commit and push** the current tree (see repo root README for branch
   conventions). App Platform deploys from GitHub, so anything uncommitted
   never reaches the server. Pin the commit you deploy (`git rev-parse
   origin/main`) — other work lands on `main` continuously.
2. **Verify locally** — these must all pass on that commit:
   ```powershell
   npm run lint
   npx tsc --noEmit
   npm test
   npm run build
   ```
3. **Runtime**: Node **24.11 or later, below 25**, and npm **11+**.
   `package.json` `engines` says so and `.npmrc` sets `engine-strict=true`, so
   `npm ci` on an older Node fails with `EBADENGINE` rather than installing.
4. **Database**: DigitalOcean Managed PostgreSQL (backups and the restore drill
   are in `docs/W1-BACKUPS.md`). Migrations are applied with
   `npm run db:migrate:run` — **not** `npm run db:migrate`: `drizzle-kit
   migrate` needs a TTY, and run headless it applies nothing and exits 0.
   `db:migrate:run` reads `.env.local` for `DATABASE_URL` (a value already in
   the environment wins), applies every pending migration in one transaction
   — a failure applies nothing — and re-running it is a no-op.

   **TLS**: DigitalOcean's connection string ends in `?sslmode=require`.
   `pg` 8 treats that as full certificate verification against Node's
   trusted CAs, and it overrides the `ssl` option in `lib/db/client.ts` and
   `scripts/migrate.mjs`. DigitalOcean signs database certificates with its
   own CA, so the app, `doctor` and the migration all fail to connect with
   the string as shown. Download the cluster's CA certificate (cluster page →
   *Download CA certificate*), put it on the host (e.g.
   `/etc/splash/do-postgres-ca.crt`, mode 644), and end `DATABASE_URL` with
   `?sslmode=verify-full&sslrootcert=/etc/splash/do-postgres-ca.crt`.
   `?sslmode=no-verify` also connects, encrypted but unverified. `doctor`'s
   Postgres row proves whichever you choose.
5. **Collect production configuration.** The environment is validated at
   startup (`lib/env.ts`, called from `instrumentation.ts`): in production a
   missing, malformed or removed key **refuses to start** and names every
   problem at once. `NODE_ENV=production npm run doctor` prints the same
   verdict as a table before you deploy.

   **Required in every production deploy**

   | Variable | Notes |
   |---|---|
   | `CUSTOMER_SESSION_SECRET` | ≥32 random chars: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `ADMIN_SESSION_SECRET` | Separate from the customer secret |
   | `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Staff console. The startup check only refuses the `.env.example` demo password, but staff sign-in is refused in production unless both are set (with `ADMIN_SESSION_SECRET`), and without it nobody can grant the first membership |
   | `CRON_SECRET` | Every `/api/cron/*` route refuses callers without `Authorization: Bearer $CRON_SECRET` |
   | `DATABASE_URL` | The managed Postgres cluster |
   | `SPLASH_PACKAGE_ID` | The published Move package |
   | `NEXT_PUBLIC_APP_URL` | `https://v1.splashz.xyz` — must be https; used by the request-origin guard. Baked into the build |
   | `EMAIL_TRANSPORT=resend`, `EMAIL_API_KEY`, `EMAIL_FROM` | `console` (the default) is refused: it only prints verification links to the server log, so nobody could be verified or granted access |

   **Chain**

   | Variable | Notes |
   |---|---|
   | `SUI_NETWORK` | `testnet` until a mainnet package exists |
   | `SUI_RPC_URL` | The **gRPC** base URL — the app uses `SuiGrpcClient`. Unset means `https://fullnode.<network>.sui.io:443`. `sui-testnet-rpc.publicnode.com` serves JSON-RPC only and answers every call "Bad Request" |
   | `SUI_MAINNET_RPC_URL` | Optional; the stablecoin lane's mainnet client. Defaults to `https://fullnode.mainnet.sui.io:443` |
   | `SUI_SETTLEMENT_MODE` | `auto` (the default and recommended), `live`, or `simulate` for demos. `auto` with mocks off is live settlement, so the defaults require the signer below |
   | `SPLASH_TREASURY_ID`, `SPLASH_PEG_STATE_ID`, `SPLASH_COMPLIANCE_CONFIG_ID`, `SPLASH_ADMIN_CAP_ID`, `SPLASH_ANCHOR_CAP_ID`, `SPLASH_BUSINESS_ACCOUNT_ID`, `DEEPBOOK_POOL_ID`, `DEEPBOOK_QUOTE_TYPE`, `USDC_TYPE` | From your working `.env.local`. `USDC_TYPE` must be the real coin type — the dev stand-in `0x2::sui::SUI` is refused |
   | `OPERATOR_SUI_ADDRESS` / `OPERATOR_SUI_PRIVATE_KEY` | Required once settlement is live (`live`, or `auto` with mocks off) or `TREASURY_EXECUTION_ENABLED=true`. Ed25519 or Secp256k1 `suiprivkey…`. **Encrypted/secret env vars only** |
   | `PASSKEY_RP_ID` | **Decide before anyone enrols a passkey.** Unset, it is the host of `NEXT_PUBLIC_APP_URL`; changing it later orphans every passkey, and a passkey's Sui address is the user's Splash wallet, so another domain means another wallet. Use the parent domain (`splashz.xyz`) if passkeys must work on more than one subdomain — see `docs/PHASE-STATUS.md` |

   **Decided by your flags**

   | When | Then set |
   |---|---|
   | `USE_MOCK_APIS` and `NEXT_PUBLIC_DEMO_MODE` both off | `PDAX_API_KEY`, `WALRUS_PUBLISHER_URL`, `WALRUS_AGGREGATOR_URL`, `ENOKI_API_KEY`; and `STRIPE_SECRET_KEY` / `AIRWALLEX_API_KEY` unless `FUNDING_PROVIDER_STRIPE_ENABLED` / `FUNDING_PROVIDER_AIRWALLEX_ENABLED` are `false` (both default on) |
   | `FEATURE_KYB_GATE=true` | `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY`; `SUMSUB_WEBHOOK_SECRET` for `/api/webhooks/sumsub`. A compliance decision: **off** (the default) the gate never blocks, so an unverified business can use USD in and local-currency payouts. **On**, a workspace moves money only once staff approve it at `/admin/kyb` |
   | `FEATURE_ZKLOGIN=true` | `ZKLOGIN_GOOGLE_CLIENT_ID` (part of address derivation — never rotate once users exist), `ZKLOGIN_USER_SALT` |
   | WhatsApp approvals | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`; point the Twilio webhook at `/api/webhooks/whatsapp` and set `TWILIO_WEBHOOK_URL` to that exact public URL — behind a proxy the request URL differs from the one Twilio signed, and every inbound message is refused |
   | MemWal | `MEMWAL_PRIVATE_KEY` and `MEMWAL_ACCOUNT_ID` together, or neither |
   | Stablecoin lane | `SPLASH_FEE_ADDRESS_MAINNET` (no USDC transfer is quoted without it), `CHAINALYSIS_SANCTIONS_API_KEY` to screen wallet recipients; optional `ETHEREUM_RPC_URL` / `USDY_ORACLE` and `DEEPBOOK_STABLE_PAIRS` (the old name `DEEPBOOK_STABLE_PAIR` is ignored). See `docs/STABLECOIN-LANE.md`, Configuration |
   | 0xWal | `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`) recommended; without it 0xWal runs the local planner |
   | Extra POST origins | `ALLOWED_ORIGINS`, comma-separated |

   **Must NOT be set** — each refuses to start by name:

   | Variable | Why |
   |---|---|
   | `CUSTOMER_EMAIL`, `CUSTOMER_PASSWORD` | The single env login is gone; accounts are rows in `users` |
   | `SPLASH_ATTESTATION_CAP_ID` | Renamed to `SPLASH_ANCHOR_CAP_ID` |
   | `SEAL_KEY_SERVER_ENDPOINTS`, `SEAL_KEY_SERVER_URLS`, `SEAL_KEY_SERVER_MODE`, `SEAL_THRESHOLD`, `SEAL_PACKAGE_ID`, `SEAL_POLICY_OBJECT_ID`, `SEAL_APPROVE_TARGET` | Seal is configured by the committed `config/seal.production.json` (see `config/README.md`). Empty servers there means Seal is unconfigured and fails closed: sealing is refused, and the Seal health row fails, so `/api/health` answers 503 until a committee is configured |

   Never commit `.env.local`. On App Platform, enter these in the dashboard.
6. **First operator.** Nobody can sign in until a membership exists. The
   sequence: sign up at `/signup` → open the verification email (a grant to
   an unverified address is refused) → a staff member signs in at
   `/admin/login` and grants a role (`maker`, `checker`, `admin` or `viewer`)
   in a workspace at `/admin/memberships`, which creates a new workspace id on
   the spot → the operator signs in. Signing up grants nothing on its own, by
   design. On an upgraded database, `0004` has already given every old user a
   membership with their old workspace and role: once they sign up again with
   the same address and open the link, they hold it. Review those at
   `/admin/memberships`.

---

## Option A — DigitalOcean App Platform (recommended)

1. **Create the app**: DO dashboard → *Apps* → *Create App* → GitHub →
   authorize → pick `sky9484/phase1`, branch `main`, autodeploy on push.
2. **Resource type**: Web Service (Node.js is auto-detected; the buildpack
   takes the Node version from `engines`).
   - Build command: `npm run build`
   - Run command: `npm run start` (Next.js binds `0.0.0.0:$PORT` automatically;
     App Platform sets `PORT`)
   - Instance: at least **1 GB RAM** (Next builds are memory-hungry; 512 MB
     often OOMs). Start with Basic 1 GB / 1 vCPU, scale later.
   - Health check: an HTTP check on `/login`. Not `/api/health`: in
     production it answers 401 without a staff session.
3. **Environment variables**: App → Settings → App-Level Environment
   Variables. Add everything from the checklist. Mark secrets as *Encrypt*.
   Set `NODE_ENV=production` (App Platform usually sets this already).
4. **Migrations**: App → Create → *Job*, kind **Pre-deploy**, same repo and
   branch, run command `npm run db:migrate:run`. It runs after the build and
   before the new version takes traffic, with the app-level environment, so
   every deploy migrates first; with nothing new to apply it is a no-op. The
   migrations run in one transaction, so a failed job applies nothing. Add
   the app to the database's trusted sources.
5. **Deploy**: Save → it builds and deploys. Watch the build logs; the first
   build takes several minutes. A deploy that fails the environment check
   logs `EnvValidationError` naming every bad key.
6. **Domain**: App → Settings → Domains → add `v1.splashz.xyz` (or your
   domain), then add the CNAME record DO shows you at your DNS provider.
   HTTPS certificates are automatic.
   - After the domain is live, make sure `NEXT_PUBLIC_APP_URL` matches it
     exactly — the origin guard (`lib/auth/customer-request.ts`) accepts the
     forwarded host, but the explicit URL is the belt-and-braces config.
7. **Redis (only if you use it)**: `docker-compose.yml` runs Redis for local
   dev. If production needs it, create a *DO Managed Redis* database and set
   `REDIS_URL`; App Platform containers don't run compose files.
8. **Cron routes**: DO → App → Settings → *Scheduled Jobs* (or an external
   cron) hitting `https://<domain>/api/cron/update-peg`, `accrue-yield`,
   `audit-batch` and `settle-withdrawals` with
   `Authorization: Bearer $CRON_SECRET`.

**Redeploys**: push to `main` → App Platform rebuilds, runs the pre-deploy
migration job, then deploys. Deleted files disappear from the server because
every deploy is a fresh build of the commit.

---

## Option B — Droplet (Ubuntu 24.04 + Node + PM2 + Nginx)

The app runs from one of two directories, `/opt/splash` and
`/opt/splash-next`. A release is built in whichever one is not live while the
live one keeps serving, then PM2 is pointed at it; the previous directory
stays untouched as the rollback. `sudo -u splash pm2 describe splash | grep
'exec cwd'` shows which one is live.

1. **Create the Droplet**: Ubuntu 24.04, Basic, ≥2 GB RAM. Add your SSH key.
   On 2 GB, add swap before the first build:
   ```bash
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
   ```
2. **Install runtime**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs nginx
   node -v   # v24.11 or later, below v25
   sudo npm i -g pm2
   ```
3. **Get the code**:
   ```bash
   sudo adduser --system --group splash
   sudo install -d -o splash -g splash /opt/splash   # splash can't create directories in /opt
   sudo -u splash git clone https://github.com/sky9484/phase1.git /opt/splash
   cd /opt/splash && sudo -u splash git checkout <RELEASE_SHA>
   ```
4. **Environment**: create `/opt/splash/.env.local` (chmod 600, owner
   `splash`) with the production values from the checklist. `npm run start`
   loads it via Next's env handling; `db:migrate:run` and `doctor` read it too.
5. **Check, migrate, build and run**:
   ```bash
   cd /opt/splash
   sudo -u splash npm ci
   sudo -u splash env NODE_ENV=production npm run doctor   # env contract must be valid
   sudo -u splash npm run db:migrate:run
   sudo -u splash npm run build
   sudo -u splash pm2 start npm --name splash --cwd /opt/splash -- run start
   sudo -u splash pm2 save && pm2 startup   # follow the printed command
   ```
   `NEXT_PUBLIC_*` values are inlined at build time: finish `.env.local`
   before `npm run build`. `doctor` exits 1 while any row fails. Before
   migrating, the Postgres row fails with "reachable, but 0/N migrations
   applied" — expected. The Seal row fails until `config/seal.production.json`
   has a committee. Any other failure needs fixing first.
6. **Nginx reverse proxy** (`/etc/nginx/sites-available/splash`):
   ```nginx
   server {
     listen 80;
     server_name v1.splashz.xyz;
     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Host $host;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       # SSE (0xWal stream) — don't buffer event streams
       proxy_buffering off;
       proxy_read_timeout 3600;
     }
   }
   ```
   `X-Forwarded-Host`/`X-Forwarded-Proto` are REQUIRED — the customer origin
   guard trusts them to recognize the public origin. `proxy_buffering off`
   is REQUIRED for the 0xWal chat stream; with buffering on, nginx holds the
   SSE frames and the chat appears dead. The app sets its own security
   headers and per-request Content-Security-Policy; don't add them in nginx.
   ```bash
   sudo ln -s /etc/nginx/sites-available/splash /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```
7. **HTTPS**: `sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d v1.splashz.xyz`
8. **Redis (optional)**: `sudo apt install redis-server` or use the compose
   file: `docker compose up -d redis`; set `REDIS_URL`.
9. **Updates** — stage beside the live directory, then switch:
   ```bash
   LIVE=/opt/splash          # from: sudo -u splash pm2 describe splash | grep 'exec cwd'
   NEXT=/opt/splash-next     # the other one

   # Stage (the site keeps serving)
   [ -d "$NEXT/.git" ] || { sudo install -d -o splash -g splash "$NEXT" && sudo -u splash git clone https://github.com/sky9484/phase1.git "$NEXT"; }
   sudo -u splash git -C "$NEXT" fetch origin
   sudo -u splash git -C "$NEXT" checkout <RELEASE_SHA>
   sudo install -m 600 -o splash -g splash "$LIVE/.env.local" "$NEXT/.env.local"
   cd "$NEXT"
   sudo -u splash npm ci
   sudo -u splash env NODE_ENV=production npm run doctor
   sudo -u splash npm run build

   # Switch (downtime: stop → migrate → start)
   date -u +%FT%TZ                       # restore point, if this release migrates
   sudo -u splash pm2 stop splash
   sudo -u splash npm run db:migrate:run
   sudo -u splash pm2 delete splash
   sudo -u splash pm2 start npm --name splash --cwd "$NEXT" -- run start
   sudo -u splash pm2 save
   sudo -u splash pm2 logs splash --lines 60 --nostream
   ```
   `doctor` reports pending migrations as a failed Postgres row until the
   switch, and Seal fails until it has a committee; every other row must
   pass. `db:migrate:run` ends with "Done. N migration(s) recorded" and exits
   1 if fewer. If the new build logs `EnvValidationError`, fix
   `$NEXT/.env.local` and `pm2 restart splash`.

   **Rollback**: if the release applied no migrations — including when
   `db:migrate:run` failed, since it applies all or nothing — start PM2 from
   `$LIVE` again. If it applied them, the old build may not run against the
   new schema — restore the database to the recorded time first
   (`docs/W1-BACKUPS.md`), point `$LIVE/.env.local` at the restored cluster,
   then start from `$LIVE`.

---

## Upgrading an older deployment

A deployment built before September 2026 (Next 16.2.x, `CUSTOMER_EMAIL`
logins, three migrations) needs all of this in one release — each alone
causes an outage:

1. **Node 24.11+** before `npm ci` (Option B step 2, then
   `sudo npm i -g pm2@latest && sudo -u splash pm2 update`, which restarts
   the old build on the new Node for a few seconds).
2. **Environment**: delete every key under *Must NOT be set*, add the
   *Required* ones (`EMAIL_TRANSPORT=resend` is the one most often missing),
   give `DATABASE_URL` the cluster's CA (checklist item 4, TLS), point
   `SUI_RPC_URL` at a gRPC host, and decide `PASSKEY_RP_ID` and
   `FEATURE_KYB_GATE`. With the gate on, every carried-over workspace starts
   `REGISTERED` and moves no money until staff approve it at `/admin/kyb`.
3. **Migrations `0003`–`0026`**. `0004_real_users` is hand-written and moves
   data — each user's org and role into `memberships` — before dropping those
   columns. Rehearse on a point-in-time fork of production first, from the
   staged checkout with the release's own dependencies:
   `sudo -u splash env DATABASE_URL='<fork, with the TLS ending>' npm run db:migrate:run`
   (the command-line value wins over `.env.local`). Compare `select count(*)
   from users` before with the rows in `memberships` after. Record a restore
   point before the real run: once it succeeds, rolling back means restoring
   the database.
4. **Logins**: old `users` rows have no password. Create the first operator
   with the sequence in checklist item 6, then review the memberships `0004`
   carried over.

`docs/PHASE-STATUS.md` ("Deploy order") has the reasoning behind each.

---

## Post-deploy smoke test (either path)

1. The health report. In production `GET /api/health` needs a staff session
   — a plain `curl` gets 401 — and answers 503 while any row fails. Read it
   with `NODE_ENV=production npm run doctor` on the server, or in the staff
   console at `/admin/go-live`. RPC names your gRPC host, the package
   resolves, and every migration in `drizzle/meta/_journal.json` is applied.
   Seal fails until `config/seal.production.json` has a committee. The go-live rows cover the setup done by hand:
   - `laneNode`, `peg` and `usdyPrice` must be `ok`.
   - `feeAddress`, `twilio` and `screening` show `skipped` until they are configured, with the reason.
   - `passkeyDomain` must be `ok` **before** anyone creates a passkey on this domain. A passkey's Sui address is tied to its domain.
2. The image optimizer serves only our own files:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' 'https://<domain>/_next/image?url=https%3A%2F%2Fexample.com%2Fa.avif&w=64&q=75'   # 400
   curl -s -o /dev/null -w '%{http_code}\n' 'https://<domain>/_next/image?url=%2Fsplash-main-icon.png&w=64&q=75'           # 200
   ```
3. `https://<domain>/login` → sign in as an operator with a granted
   membership (checklist item 6 for the first one).
4. Dashboard 0xWal chat → send "What can you read and prepare?" → the chat
   should expand and stream a reply (claude mode if `ANTHROPIC_API_KEY` is
   set; local planner otherwise). If you see "could not open a secure line",
   check the SSE/nginx notes above and the origin guard env vars.
5. Transfer → complete a quote (`/api/quotes` 200) and, if settlement is
   configured, a full send.
6. Batch → upload `samples/batch-payout-sea-1.csv` → screen → authorize.
7. Invoices → both tabs (vault + inspection loop) load; `/dashboard/0xwal`
   redirects into the loop tab.
8. `/queue` renders the approval lanes.
9. Cron → the next scheduled run logs 200, not 401 (a 401 means
   `CRON_SECRET` differs between the scheduler and the app). Don't trigger
   `settle-withdrawals` by hand.
