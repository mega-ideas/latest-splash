# Mainnet verification gate (v2, Phase 0)

Date: 24 Oct 2026. Prompt: `SPLASH_SUI_V2_PROMPT.md` §2. Base: `main` @ `d39d428`.

**Verdict: not passed. Phase 1 has not started.** Four checks pass and two need
a person before they can be proven on testnet. Nothing below sent a transaction,
used a key, or touched mainnet beyond reads.

| # | Check | Result |
|---|---|---|
| 1 | `0x2::allowance` on mainnet | **Pass**, with a design constraint (see below) |
| 2 | Address balances (USDC) | **Mainnet pass; testnet USDC proof blocked** (no testnet funds) |
| 3 | Passkeys inside a Sui multisig | **Mainnet protocol pass; testnet 2-of-3 proof blocked** (no testnet gas; real passkeys need a person) |
| 4 | `@mysten/sui` 2.31.3 and the Sui CLI | **Pass; CLI must be upgraded** before Phase 1 |
| 5 | CCTP V2 on Sui | **Pass.** Fast Transfer: not offered for Sui (N/A) |
| 6 | Partner USDC deposit networks | **Ask partner** (not a blocker) |

## How mainnet was read

The prompt's command, `sui_getNormalizedMoveModule` over JSON-RPC, no longer
works: mainnet's public fullnode answers
`"JSON-RPC on public fullnodes has been deprecated. Please migrate to gRPC or GraphQL endpoints."`
Every read below uses the public GraphQL endpoint instead:

```bash
curl -s --ssl-no-revoke https://graphql.mainnet.sui.io/graphql -H 'Content-Type: application/json' -d '<query>'
```

`--ssl-no-revoke` is needed only on this Windows machine, whose TLS revocation
check fails (`CRYPT_E_NO_REVOCATION_CHECK`).

Chain: `chainIdentifier` `4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S`,
epoch 1289, **protocol version 139**, framework package `0x2` version 60.

## 1. `0x2::allowance` on mainnet

Query: `{ package(address:"0x2") { module(name:"allowance") { function(name:"…") { visibility isEntry parameters { repr } return { repr } } } } }`

| Function | Visibility | Signature (`0x1`/`0x2` prefixes shortened) |
|---|---|---|
| `new<T>` | **private `entry`** | `(String, address, Option<u256>, Option<u64>, Option<u64>, Option<RateLimit>, &mut TxContext)` |
| `propose_for_app<T, App>` | **private `entry`** | same arguments with `&TxContext` → `AllowanceProposal<T>` |
| `issue<T, App>` | public | `(AllowanceProposal<T>, SettingsPermit<App>, &mut TxContext)` |
| `balance_spend<T>` | public | `(&mut Allowance<Balance<T>>, AllowanceWithdrawal<Balance<T>>, &Clock, &TxContext) → Balance<T>` |
| `app_balance_spend<T, App>` | public | `(&mut Allowance<Balance<T>>, SpendPermit<App>, AllowanceWithdrawal<Balance<T>>, &Clock, &TxContext) → Balance<T>` |
| `spend_permit<App>` | public | `(internal::Permit<App>) → SpendPermit<App>` |
| `revoke<T>` | public | `(AllowanceCap<T>, Allowance<T>)` |
| `periodic_rate_limit` | public | `(u64, u256) → RateLimit` |
| `monthly_rate_limit` | public | `(u256) → RateLimit` |

Also present: `rotate_spender<T, App>(&mut Allowance<T>, SettingsPermit<App>, address)`,
`settings_permit<App>(internal::Permit<App>)`, `calendar_rate_limit`,
`quarterly_rate_limit`, `yearly_rate_limit`, `lifetime_cap`, `funder`, `spender`,
`allowance_current_spend`, `rate_limit_spent`, `rate_limit_window`.

Abilities: `Allowance` and `AllowanceCap` are `key` only; `AllowanceProposal`,
`AllowanceWithdrawal`, `SpendPermit` and `SettingsPermit` are `drop` only;
`RateLimit` is `copy, drop, store`.

Feature flag: `enable_allowances = true`.

**What this means for Phase 1**

- `new` and `propose_for_app` are **private `entry`**. A transaction can call
  them as a top-level command, signed by the funder (the business multisig).
  **No Move package can call them**, so `splash_spend` cannot wrap allowance
  creation; it can only accept a proposal the multisig made in the same
  transaction. The testnet proof (check 3) must show a PTB passing the
  `AllowanceProposal` that `propose_for_app` returns into
  `splash_spend::accept`, because entry-function results have restrictions in
  PTBs.
- `rotate_spender` and `issue` both need a `SettingsPermit<App>`, and only the
  module that defines `App` can make the `internal::Permit<App>` behind it. So
  `splash_spend` is the only code that could ever rotate a spender, and the
  prompt's rule (no `rotate_spender` in `splash_spend`, and no permit exposed
  outside it) closes that door completely. `accept` must create the permit and
  hand it straight to `issue`, never return it.
- Allowance caps are `u256`; USDC has 6 decimals. Caps must be built from
  minor units.

## 2. Address balances

| Function | Signature |
|---|---|
| `balance::send_funds<T>` | `(Balance<T>, address)` |
| `balance::redeem_funds<T>` | `(funds_accumulator::Withdrawal<Balance<T>>) → Balance<T>` |
| `coin::redeem_funds<T>` | `(Withdrawal<Balance<T>>, &mut TxContext) → Coin<T>` |
| `coin::send_funds<T>` | `(Coin<T>, address)` |
| `balance::withdraw_funds_from_object<T>` | `(&mut UID, u64) → Withdrawal<Balance<T>>` |
| `funds_accumulator::withdrawal_split<T>` | `(&mut Withdrawal<T>, u256) → Withdrawal<T>` |

Feature flags: `enable_accumulators = true`, `create_root_accumulator_object = true`,
`enable_object_funds_withdraw = true`, `enable_address_balance_gas_payments = true`.
The SDK exposes withdrawal inputs (`type: "withdrawal"`) and allowance-backed
balances (`AllowanceBalance`, `from: 'allowance'`).

**Blocked: the USDC proof on testnet.** The prompt requires showing
`send_funds`, `redeem_funds` and a funds-withdrawal input working **with USDC**
on testnet first. USDC is a regulated coin (it has a deny list), so it is the
case most likely to behave differently from SUI and the one worth proving. It
needs a testnet address holding testnet USDC and testnet SUI, and both faucets
need a person:

- the Sui testnet faucet refuses scripted requests: `{"error":"CI compatibility is disabled","code":"compatibility_disabled"}`;
- Circle's testnet USDC faucet (faucet.circle.com) is a web form.

## 3. Passkeys inside a Sui multisig

Mainnet feature flags: `passkey_auth = true`, `accept_passkey_in_multisig = true`,
`accept_zklogin_in_multisig = true`, `upgraded_multisig_supported = true`,
`additional_multisig_checks = true`.

So the protocol accepts passkey (secp256r1/WebAuthn) members in a multisig on
mainnet, and zkLogin members as the fallback D1 names.

**Blocked: the testnet proof.** The prompt asks for a 2-of-3 multisig of real
passkeys from `lib/wallet/sui-signers.ts` signing an allowance `new` and an
app-bound `propose_for_app` on testnet. That needs:

1. testnet SUI for gas at the multisig address (the faucet refuses scripts, as above);
2. three real passkeys, which means a person creating them on a device with an
   authenticator (Windows Hello, a phone, a security key);
3. for `propose_for_app`, an app type whose module can `issue` the proposal,
   that is, a test package with an `accept` function published to **testnet**,
   built with a CLI that has `sui::allowance` (check 4).

## 4. SDK and CLI

- `@mysten/sui` is **2.31.3** in `package.json` and `node_modules`. It ships
  `AllowanceBalance` and `SenderAllowance` (`dist/transactions/intents/AllowanceBalance.mjs`,
  `dist/transactions/data/v2.d.mts`) and the `PasskeyKeypair` / `PasskeyProvider` API.
- **The installed Sui CLI is 1.77.2, which has no `sui::allowance`.** The
  framework source first contains `allowance.move` at **`mainnet-v1.80.1`**
  (404 at `mainnet-v1.77.2`, `v1.78.1`, `v1.79.1`; 200 at `v1.80.1`, `v1.81.1`,
  `v1.82.3`, checked against `raw.githubusercontent.com/MystenLabs/sui/<tag>/crates/sui-framework/packages/sui-framework/sources/allowance.move`).
- The latest mainnet release is **`mainnet-v1.82.3`**. Pin that.
- The CLI note in `move/*/Move.toml` is a file under `move/`, which Sebastian
  approves, so it changes in the Phase 1 PR, not here.

## 5. CCTP V2 on Sui

Source: Circle, *CCTP Sui packages and interfaces*,
https://developers.circle.com/cctp/references/sui-packages (read 24 Oct 2026).
Sui is **domain 8**. Three of the packages were also confirmed on chain through
GraphQL, each returning its module list: mainnet and testnet
`TokenMessengerMinterV2`, and mainnet `MessageTransmitterV2`. The rest are as
Circle publishes them and are checked the same way in Phase 1, before any code
uses them.

| Network | Object | ID |
|---|---|---|
| Mainnet | MessageTransmitterV2 (package) | `0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87` |
| Mainnet | TokenMessengerMinterV2 (package) | `0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830` |
| Mainnet | StablecoinHandler (package) | `0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf` |
| Mainnet | CctpExtensions (package) | `0x194c593691aed72b23b967cacad967a93c0b17ff98180d417e91ac503ce3597d` |
| Mainnet | MessageTransmitterV2 state | `0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c` |
| Mainnet | TokenMessengerMinterV2 state | `0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167` |
| Mainnet | StablecoinHandler state | `0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41` |
| Mainnet | USDC Treasury | `0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7` |
| Testnet | MessageTransmitterV2 (package) | `0xe9678cd42a81886e18e21361088071f275105636a4d3751e1d7f255211f73bbe` |
| Testnet | TokenMessengerMinterV2 (package) | `0x267d3c0cb776eace2840f27e4d33da9c6d952f9749403f1fe6579f4962ed3c64` |
| Testnet | StablecoinHandler (package) | `0xbe8479044396a45e07de2c7f14789c35b8338406eebc53b2527da56839a91561` |
| Testnet | CctpExtensions (package) | `0x3cdb05f9a035c147410f5a9cfe2ccb741f4ab3cd59411e86714ce4b45e2c4d95` |
| Testnet | MessageTransmitterV2 state | `0xfee3a2b47f9ef2de2405fc63d79194307945f8ea768815cfc46083bc20fbe6ed` |
| Testnet | TokenMessengerMinterV2 state | `0x72cb55cd14d01e6361386d6ea93eecda9fa1efc3c202b8dd69c1e4683e4c0ca0` |
| Testnet | StablecoinHandler state | `0xfbd9c0517c4f0e1817445ee2be598806e3c392a465d7e3d773d1055f3f0eed32` |
| Testnet | USDC Treasury | `0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe` |

`CctpExtensions` has no state object on either network (Circle).

Mainnet `deposit_for_burn::deposit_for_burn<T>` takes
`(Coin<T>, u32 destination_domain, address mint_recipient, address destination_caller, u256 max_fee, u32 min_finality_threshold, vector<u8> hook_data, &State, &mut TxContext)`,
the V2 shape.

**Fast Transfer from Sui: no.** Circle's *Supported blockchains and domains*
(https://developers.circle.com/cctp/concepts/supported-chains-and-domains)
lists Sui as `Source (Standard transfer) ✅`, `Source (Fast transfer) N/A`,
`Source (Upfront fees) ❌`, `Forwarding Service ❌`. N/A means Circle does not
offer Fast Transfer where standard attestation is already fast. Every listed
chain is supported as a destination.

As D13 warns, Circle's site still carries one contradicting line: its generic
guidance text says "Noble, Sui, and Aptos still require V1". The Sui packages
page and the on-chain packages are V2; the guidance line is out of date.

## 6. Partner USDC deposit networks

Hata (MY), PDAX (PH), Tokocrypto (ID), Bitkub (TH): **ask partner.** None of
them publishes an authoritative per-network deposit list we can cite, and the
prompt allows this item to stay open.

## What is needed to finish the gate

1. A person funds one testnet address with testnet SUI (faucet.sui.io) and
   testnet USDC (faucet.circle.com). The address comes from a throwaway
   testnet key made only for this proof; no Splash key is used.
2. Three real passkeys for the 2-of-3, created by people on their own devices
   through the app's passkey flow (`lib/wallet/sui-signers.ts`).
3. Sui CLI `mainnet-v1.82.3` installed, to build and publish the small testnet
   package that accepts the app-bound proposal.

Then checks 2 and 3 run, their digests are added here, and Phase 1 can start.
