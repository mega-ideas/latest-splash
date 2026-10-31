# Contract config

The Splash protocol publishes new on-chain object IDs every time the Move
package is republished — package ID, treasury / settlement pool, admin cap,
peg state, business account, and so on. Historically those IDs lived only in
`.env.local` on the production host, which meant every redeploy required an
SSH session, a hand-edited env file, and a `systemctl restart`.

The admin **Contract config** page replaces that loop. Staff paste the new IDs
into a form; the values are written to a runtime JSON store and picked up by
the next request — no restart needed.

## Where the values live

There are two layers, merged at read time:

1. **`.env.local`** — boot-time fallback, still the source of truth for fresh
   deploys, CI, and local development.
2. **`data/contract-config.json`** — runtime overrides written by the admin
   page. Values present here override the env. The file is git-ignored.

The loader (`lib/server/contract-config.ts`) reads the JSON file on each call,
keyed by mtime so re-reads are free unless the file actually changes. Updates
made through the admin page are visible to the *very next request*; there is
no module-level caching, no in-process pinning, no service restart.

## Fields

| Field | Env key | Notes |
|---|---|---|
| `packageId` | `SPLASH_PACKAGE_ID` | 0x + 64 hex. Required for settlement and peg refresh. |
| `treasuryId` | `SPLASH_TREASURY_ID` | `SettlementPool<SUI>` shared object. |
| `adminCapId` | `SPLASH_ADMIN_CAP_ID` | `business_account::AdminCap` owned by the operator wallet. |
| `pegStateId` | `SPLASH_PEG_STATE_ID` | `peg_monitor::PegState` shared object. |
| `businessAccountId` | `SPLASH_BUSINESS_ACCOUNT_ID` | `business_account::BusinessAccount` shared object. |
| `transferCoinId` | `SPLASH_TRANSFER_COIN_ID` | Optional. SUI coin pre-funded for test transfers. |
| `settlementRegistryId` | `SPLASH_SETTLEMENT_REGISTRY_ID` | Optional. |
| `testRecipientAddress` | `SPLASH_TEST_RECIPIENT_ADDRESS` | If set, the testnet single settlement is forced to this recipient. |
| `operatorAddress` | `OPERATOR_SUI_ADDRESS` | The operator wallet address. |
| `treasuryAddress` | `TREASURY_ADDRESS` | |
| `usdcType` | `USDC_TYPE` | Move type, e.g. `0x2::sui::SUI`. |
| `usdtType` | `USDT_TYPE` | Optional Move type. |
| `usdtBufferId` | `USDT_BUFFER_ID` | Optional. |

`packageId`, `treasuryId`, `adminCapId`, `pegStateId`, `businessAccountId`,
`transferCoinId`, and `settlementRegistryId` are validated as Sui
object/package IDs (`/^0x[a-fA-F0-9]+$/`, package ID must be 64 hex).
Addresses must be canonical (`0x` + 64 hex). Move-type fields are matched
against `0xpkg::module::TYPE`.

## How it flows through the app

`getContractConfig()` is called by every path that needs an on-chain
reference:

- `lib/server/sui-settlement.ts` — `recordSingleTransferOnSui` and the
  (currently unused) `updatePegOnSui`. (`recordBatchSettlementOnSui` was
  removed in v2 Phase 3.)
- `lib/sui/contracts.ts` — `buildUpdatePriceTx` and
  `buildSubmitBusinessApplicationTx`.
- `lib/server/operations.ts` — the unified transaction log surfaces the
  active package ID alongside each transfer.

The loader never throws on missing values. Functions that *require* a value
call `configIdOrThrow(field, envKey)`, which raises a typed error containing
the env-key hint so the operator can fix the gap from the admin page or the
env file.

## Updating the active config

### Via the admin page (preferred)

1. Sign in at `/admin/login`.
2. Open **Contract config** in the sidebar.
3. Paste the new IDs into the fields. Fields validate inline; invalid entries
   are highlighted before submit.
4. Click **Save changes**. The next settlement, peg refresh, or admin call
   uses the new values.

The page also offers per-field shortcuts:

- **Copy** — copy the live value to the clipboard.
- **Revert to env** — restore the value from `.env.local` (clears the runtime
  override for that field).
- **SuiVision** — open the canonical view of the ID on the active network.

### Via the file (CI / scripted)

Write to `data/contract-config.json` directly with restrictive permissions:

```jsonc
{
  "packageId": "0xabc…",
  "treasuryId": "0xdef…",
  "adminCapId": "0x…",
  "pegStateId": "0x…",
  "businessAccountId": "0x…",
  "transferCoinId": "0x…",
  "testRecipientAddress": "0x…",
  "usdcType": "0x2::sui::SUI"
}
```

Atomic writes only — write to a sibling `.tmp.<pid>.<ts>` file and `rename`
into place, otherwise an in-flight `getContractConfig()` may see a
half-written file.

### Via the API

```
PUT /api/admin/contracts
Content-Type: application/json
Cookie: splash_admin_session=…

{ "packageId": "0x…", "treasuryId": "0x…", … }
```

See [`openapi.yaml`](./openapi.yaml) for the full contract.

## Troubleshooting

### `E_PEG_STALE` (Move abort 302)

The peg reading was older than 60 s when settle ran. The single-transfer PTB
bundles a `peg_monitor::update_peg` step, so this usually means
`SPLASH_ADMIN_CAP_ID` or `SPLASH_PEG_STATE_ID` is wrong. Open the admin page
and verify both fields.

### `ObjectNotFound`

The object ID is well-formed but doesn't exist on the active network. Most
common after switching `SUI_NETWORK` between `testnet` and `mainnet` without
updating the IDs. The admin page deep-links to SuiVision for each ID so you
can confirm existence in one click.

### "X is not configured"

A required field is empty in both the env and the runtime JSON store. Set it
in the admin page (preferred) or in `.env.local`.

## Why not put this in a database

The dataset is one row. The app already has a Redis cache (used for
quotes/peg) but no relational store. A flat JSON file:

- needs zero schema migrations,
- is trivially backed up and inspected,
- survives container restarts,
- and is small enough that the mtime-keyed read costs nothing.

If a future feature needs versioning (e.g. "roll back to the v3 deploy's
package"), the JSON format already includes only the active config — add a
sibling `data/contract-config.history.jsonl` and append on save.

## Operational safety

- The admin page is gated by `getAdminSession()`; the API returns `401`
  without a valid `splash_admin_session` cookie.
- The JSON file is written with `0o600` permissions.
- Saves are atomic (`rename(2)`), so a crash mid-write never leaves a
  partial config on disk.
- The form clears its in-memory error state on input change; saves never
  short-circuit validation.

## File reference

| Path | Purpose |
|---|---|
| `lib/server/contract-config.ts` | Store + loader + validators |
| `app/api/admin/contracts/route.ts` | `GET` / `PUT` admin API |
| `app/admin/(console)/contracts/page.tsx` | Server component, hydrates the form |
| `components/admin/ContractConfigForm.tsx` | Client form |
| `data/contract-config.json` | Runtime override file (git-ignored) |
