# Splash Upgrade Policy

Status: v2 (decision D11, `SPLASH_SUI_V2_PROMPT.md`), 24 Oct 2026. Design:
`docs/v2/phase1-move-design.md`. This replaces the earlier plan to publish
`splash_core` immutable.

## Which package can change, and how

| Package | Upgrades | Why |
|---|---|---|
| `splash_core` | **Additive only**, through `splash_upgrade_delay`, by the 2-of-3 governance multisig | New functions and types can be added; no existing function can change |
| `splash_upgrade_delay` | **Never** (published immutable) | A delay its holder could shorten would be a delay in name only |
| `splash_spend` | **Never** (published immutable) | Whoever could upgrade the allowance app could rotate every spender (Sui docs) |
| `splash_custody`, `splash_meter` | Not on the mainnet path | Retired in v2: allowances and address balances replace pooling and the spend meter |

A fix to `splash_spend` therefore means a new package, with new
`SPLASH_SPEND` and `SettleWitness` types. Every business then revokes its old
allowances and proposes new ones under the new app (design §9).

## The 24-hour delay

`splash_core`'s `UpgradeCap` lives inside a `DelayedUpgradeCap` and never comes
out:

1. The publisher transfers the `UpgradeCap` to the governance multisig. The
   multisig calls `upgrade_delay::wrap` itself, passing its members, and the
   call proves on chain that it is a quorum no single member can sign for. If
   the policy is looser than additive, `wrap` makes it additive. A cap that has
   already been used is refused.
2. To upgrade, governance calls `propose(digest)` with the 32-byte digest of
   the new bytecode. `UpgradeProposed` is emitted.
3. **The backend alerts every business owner**: in the app, by email, and by
   WhatsApp where an owner has verified it. The alert links to their spending
   rules and allowances. Only events from the canonical wrapper, about the
   canonical core package, count. Anyone can create a wrapper of their own, so
   an unfiltered alert would be a phishing channel. `/api/cron/governance-alerts`
   does this (the decision is `lib/server/governance-events.ts`); it must be
   scheduled every 15 minutes (`docs/DEPLOY-DIGITALOCEAN.md`). WhatsApp sends
   free text, which WhatsApp delivers only inside a 24-hour customer window,
   so until an approved template exists the app and email carry the alert.
4. No sooner than 24 hours later, and no later than 7 days after that,
   governance calls `authorize_upgrade(digest)` for the same digest, runs the
   upgrade, and calls `commit_upgrade`. Owners are alerted again on
   `UpgradeAuthorized`. A proposal that lapses must be proposed again, with a
   fresh alert.

Moving the wrapper to a new governance multisig, for example after a signer
change, goes through the same notice: `propose_owner_change`, then
`complete_owner_change`. `only_dep_upgrades` and `make_immutable` need no
notice, because they only remove power.

**What an additive upgrade can still do.** It can add a function that writes a
core object's fields, for example an intent's status. So a malicious core
upgrade could make a spender pay a verified recipient twice, within that
spender's caps. It cannot add a recipient, raise a limit or create an
allowance: those live in `splash_spend`'s `SpendPolicy`, which core cannot
reach. That residual risk is why every proposal alerts every owner, and the
alert says so.

## Registry additions

Adding an accepted asset, a settlement app (`splash_spend`'s `SettleWitness`)
or a bridge adapter goes through the same steps in `compliance_config`:

1. `propose_addition` with `AdminCap`, and on-chain proof that the sender is a
   quorum multisig.
2. 24 hours of notice, with an owner alert on `RegistryAdditionProposed`.
3. `activate_addition` with the same requirements, within 7 days of the
   notice running out.

Removals are immediate and subtractive. The last accepted asset cannot be
removed; `pause` is the halt. A bridge adapter must be **immutable**. A new
version from Circle means a new adapter type through this path, and the old
one is removed.

## Upgrade gate

Before any proposal:

1. Scope the changed modules and update `SECURITY.md` if a finding changes
   status.
2. Run `sui move build` and `sui move test` with Sui CLI `mainnet-v1.82.3` for
   every package. `sui::allowance` first ships in `v1.80.1`.
3. Confirm every new abort code is in `lib/server/sui-settlement.ts::ABORT_CODES`
   (`npm run check:aborts`).
4. Confirm `compliance_config::assert_active` is wired into any new money-moving
   function.
5. `npm run lint` passes, including `check:core` (no value-bearing field in
   core) and `check:spend` (no spender rotation, no permit leak).
6. Publish the source commit for the digest, so the backend can rebuild it and
   show owners what changes.
7. Record the testnet package digest, upgraded package ID, `DelayedUpgradeCap`
   object ID, multisig transaction digests, and the rollback decision.

## Rollback and pause

If an upgrade changes settlement, treasury, receivable or evidence behavior,
prepare an emergency pause transaction before executing it. If post-upgrade
verification fails, pause first (`compliance_config::pause` by `ComplianceCap`
or `admin_set_paused` by `AdminCap`), then assess. Off-chain routes refuse to
submit while the on-chain config is paused.

## Out of scope until approved

- Enabling third-party receivable financing.
- Any upgrade that introduces customer-fund custody claims not reflected in
  the compliance and licensing docs.
