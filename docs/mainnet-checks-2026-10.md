# Mainnet verification gate (v2, Phase 0)

Prompt: `SPLASH_SUI_V2_PROMPT.md` §2. Base: `main` @ `d39d428`.
Mainnet reads: 24 Oct 2026. Testnet transactions: 23 Oct 2026 19:26–19:46 UTC
(24 Oct 03:26–03:46 MYT).

**Verdict: passed.** Every check is proven on chain. One requirement, as the
brief words it, was met with software passkeys, and Sky accepted that for the
gate on 24 Oct 2026. Check 3 asks for "a 2-of-3 of real passkeys from
`lib/wallet/sui-signers.ts`". The proof used **software** WebAuthn
passkeys, and `sui-signers.ts` has no multisig code yet. The protocol question
(passkey members in a Sui multisig, signing allowances) is answered on testnet.
The hardware 2-of-3 is the first test of Phase 2.1.

Mainnet was only read. Every transaction ran on **testnet**, signed by a
throwaway testnet key and three software passkeys made for this proof. No
Splash key was used, and nothing was published to mainnet.

| # | Check | Result |
|---|---|---|
| 1 | `0x2::allowance` on mainnet | **Pass.** All nine functions present; `new` and `propose_for_app` are private `entry` |
| 2 | Address balances with USDC | **Pass.** `balance::send_funds`, `coin::send_funds`, `balance::redeem_funds`, `coin::redeem_funds` and both withdrawal inputs run with USDC on testnet; same bytecode as mainnet |
| 3 | Passkeys inside a Sui multisig | **Pass** (software passkeys, accepted by Sky). 2-of-3 passkey multisig signed `new`, `propose_for_app` + accept, withdrawals and `revoke`; one passkey alone is refused |
| 4 | `@mysten/sui` and the Sui CLI | **Pass.** SDK locked at 2.31.3; CLI `mainnet-v1.82.3` installed and the existing Move packages pass on it (see §4) |
| 5 | CCTP V2 on Sui | **Pass.** Domain 8; all 16 package and state IDs resolve on chain. Fast Transfer *from* Sui: N/A |
| 6 | Partner USDC deposit networks | **Ask partner** (allowed by the brief) |

Raw evidence: every query and its full response, with the time it was read, is
in `experiments/v2-phase0/reads/` (regenerate with
`node experiments/v2-phase0/capture-evidence.mjs`). The testnet proof is
`experiments/v2-phase0/testnet-proof.mjs`; its results, with every digest, are in
`experiments/v2-phase0/testnet-proof-results.json`.

## How the chain was read

The brief's command, `sui_getNormalizedMoveModule` over JSON-RPC, no longer
works. Mainnet's public fullnode answers
`"JSON-RPC on public fullnodes has been deprecated. Please migrate to gRPC or GraphQL endpoints."`
Every read uses Sui GraphQL instead. One runnable example:

```bash
curl -s --ssl-no-revoke https://graphql.mainnet.sui.io/graphql -H 'Content-Type: application/json' -d '{"query":"{ chainIdentifier epoch { protocolConfigs { protocolVersion } } }"}'
```

`--ssl-no-revoke` is needed only on this Windows machine, whose TLS revocation
check fails (`CRYPT_E_NO_REVOCATION_CHECK`). Transactions go through the SDK's
gRPC client (`https://fullnode.testnet.sui.io:443`).

| | Mainnet | Testnet |
|---|---|---|
| Chain identifier | `4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S` | `69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD` |
| Epoch | 1289 | 1261 |
| **Protocol version** | **139** | 139 |
| Framework `0x2` package version | 60 | 58 |

The version counters differ, but the four modules the proof used
(`allowance`, `balance`, `coin`, `funds_accumulator`) have **byte-identical
bytecode** on both networks (sha256 of each module's bytes, in
`reads/02-framework-functions.json`). Five feature flags differ, all `false` on
mainnet and `true` on testnet: `allow_dkg_completion_after_timeout`,
**`check_object_funds_withdraw_in_execution`**, `disable_effects_tx_dependencies`,
`enable_ristretto255_group_ops`, `enable_verify_bulletproofs_ristretto255`. The
second concerns withdrawals from objects, so testnet is a close but not perfect
stand-in for mainnet withdrawal execution.

## 1. `0x2::allowance` on mainnet

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
`quarterly_rate_limit`, `yearly_rate_limit`, `funder`, `spender`,
`lifetime_cap`, `allowance_current_spend`, `rate_limit_spent`, `rate_limit_window`.

Abilities: `Allowance` and `AllowanceCap` are `key` only; `AllowanceProposal`,
`AllowanceWithdrawal`, `SpendPermit` and `SettingsPermit` are `drop` only;
`RateLimit` is `copy, drop, store`. Flag: `enable_allowances = true`.

## 2. Address balances, with USDC

Mainnet signatures: `balance::send_funds<T>(Balance<T>, address)`,
`balance::redeem_funds<T>(funds_accumulator::Withdrawal<Balance<T>>) → Balance<T>`,
`coin::redeem_funds<T>(Withdrawal<Balance<T>>, &mut TxContext) → Coin<T>`,
`coin::send_funds<T>(Coin<T>, address)`,
`balance::withdraw_funds_from_object<T>(&mut UID, u64) → Withdrawal<Balance<T>>`,
`funds_accumulator::withdrawal_split<T>(&mut Withdrawal<T>, u256) → Withdrawal<T>`.
Flags: `enable_accumulators`, `create_root_accumulator_object`,
`enable_object_funds_withdraw`, `enable_address_balance_gas_payments` all `true`.

**Testnet proof with USDC** (`0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC`,
6 decimals). USDC is a regulated coin with a deny list, which is why it, not
SUI, is the case worth proving.

| Step | What ran | Digest |
|---|---|---|
| Into an address balance | `coin::send_funds<USDC>`: 5 USDC into the multisig's address balance | `F7wFkVvRW4XEySdC1whfPGgkgMHXopdcHXzBAK3WqKRV` |
| Withdrawal input → `Balance` | sender withdrawal input → `balance::redeem_funds` → `balance::send_funds` (0.1 USDC) | `FgdEj3r9zHFfzHdhj6pdrNmMkVz7dkBdWNNDtTNkd6eP` |
| Withdrawal input → `Coin` | sender withdrawal input → `coin::redeem_funds` → `coin::send_funds` (0.05 USDC) | `39Ek28cf5N212aBm9HvQHk3f6fZk5xAVC3ja24dw7DAL` |
| Allowance withdrawal input | spender's `SenderAllowance` input → `app_balance_spend` (0.25 USDC) | `87vbod26w7b2n7hpcJEbdtwwZBmZbvsAXi4B9pe2Jguf` |

The `Coin` path matters: CCTP's `deposit_for_burn` takes a `Coin<USDC>` (§5).

Read back from chain (`reads/04-testnet-proof-readback.json`): after funding,
the multisig held `addressBalance` 5,000,000 and `coinBalance` 0; now it holds
`addressBalance` 4,500,000 and `coinBalance` 0. The USDC never sat in coin
objects.

Both multisig withdrawals ran **gasless** (gas budget 0, price 0, no gas
object; `enable_gasless = true` on both networks). A business multisig may not
need SUI for simple USDC withdrawals. This is a Phase 2 design input, within
protocol limits that still need reading.

Funding: the Sui testnet faucet refuses scripted requests
(`"CI compatibility is disabled"`) and Circle's USDC faucet is a web form, so
Sky funded the throwaway address
`0xbf0e26d068caf355e9fb0767e33d33920b2e525b3b9351b24d30a2811dc3f872` by hand:
1 SUI (`7Ka5qX3P…`), 20 USDC (`Hj3VN3rn…`) and 200 SUI (`5XdXfYsQ…`). The proof
paid gas from the 200 SUI coin. That key still holds about 200 testnet SUI and
15 USDC.

## 3. Passkeys inside a Sui multisig

Mainnet flags: `passkey_auth`, `accept_passkey_in_multisig`,
`accept_zklogin_in_multisig`, `upgraded_multisig_supported`,
`additional_multisig_checks` all `true`. So D1's design (passkey members, zkLogin
as fallback) is allowed by the protocol on mainnet.

**Testnet proof.** Multisig
`0xafea5352bb6313c6af89594eac518d24049e5bc6dfd4bbc18a14bf191f82b6b5`: three
passkey members, weight 1 each, threshold 2.

| Step | Signed by | Digest |
|---|---|---|
| `allowance::new<Balance<USDC>>` (cap 1 USDC, 1 h expiry) | passkeys 1 + 2 | `5Gek4T33LPFTTbDUYTMtrpiaDon8uTYXy283wumgnnG2` |
| `propose_for_app<Balance<USDC>, PROBE>` → `probe::accept` → `issue`, one PTB | passkeys 2 + 3 | `FKWDnEqCqrQniDzU97KqibTcuedyPTNVyiQZF3Wt8Kp7` |
| withdrawal → `balance::redeem_funds` | passkeys 1 + 3 | `FgdEj3r9zHFfzHdhj6pdrNmMkVz7dkBdWNNDtTNkd6eP` |
| withdrawal → `coin::redeem_funds` | passkeys 2 + 3 | `39Ek28cf5N212aBm9HvQHk3f6fZk5xAVC3ja24dw7DAL` |
| app-bound allowance for a staff key | passkeys 1 + 3 | `Hmf9T53uPCrsNZVfAGny4hP3D6VnD6gCpdLongjtY95Q` |
| `allowance::revoke` | passkeys 1 + 2 | `FEHNwcQ2XxxdDsnfHozUenySGyKsPBngQJjFYUByDuWo` |

Read back from chain, independently of the script: each of these six
transactions is `SUCCESS`, sent by the multisig, with a `MultiSig` signature
whose three members are all `Passkey` and whose two signatures are both
`Passkey`. The bitmaps (3, 6, 5, 6, 5, 3) show every pair of the three
passkeys signing. The funding, app-spend, sponsored-spend, publish and
make-immutable transactions were signed by ordinary Ed25519 keys (the funder,
or the staff key).

**Multisig address, two independent ways.** The validators accepted
transactions with sender `0xafea…b6b5` under this multisig signature, which is
the decisive check. Separately, the address was recomputed from the raw
33-byte compressed keys, as the chain decoded them from a signature, with the
layout written out by hand
(`blake2b256(0x03 || 02 00 || [0x06 || key || 01] × 3)`): it matches
(`reads/05-multisig-derivation.json`). In `testnet-proof-results.json`, each
member's `flagAndCompressedPubkeyHex` already starts with the `0x06` flag. Do not
prepend it again. This is the first Phase 1 test vector.

**The app-bound allowance on chain**
(`0x084e9078fafff0246443e2362e7f7fe3eedcacfd8fc636a9eb6103432bd61d80`): shared;
funder = the multisig; spender = the funder test address; app =
`0xa21e6a5c70d2069ce13b57ace0f69cdf273550312ee306a9729f1010d8a4e82c::probe::PROBE`;
`current_spend` 250,000 of a 1,000,000 cap. Its `AllowanceCap` is owned by the
multisig. The revoked plain allowance no longer exists.

The `AllowanceProposal` returned by the private `entry` `propose_for_app` passes
straight into a public Move function in the same PTB.

**Sponsored spend by a staff key with no SUI**
(`mirMfkMfAL4ZRdPSrZJdoYtv6S7Ug61GAzyAgt42oSE`): sender = staff key
`0x956d9c62…`, which holds no balance of any kind; gas sponsor = the funder;
0.1 USDC moved out of the multisig's address balance under the staff
allowance. Sponsoring a spender's gas works. (Sponsor-bound *withdrawals*,
where the sponsor rather than the spender is charged, are not enabled:
`ESponsorWithdrawalNotEnabled`.)

**Negative results** (observed by the script; a refused transaction has no
digest):

| Case | Result |
|---|---|
| a transfer signed by **one** passkey | refused at signature check: `Insufficient weight=1 threshold=2` |
| spending 2 USDC against a 1 USDC cap | `MoveAbort … EExceedsLifetimeCap` (dry run) |
| 750,000 more against 250,000 spent of 1,000,000 (exactly at the cap) | would succeed (dry run) |
| 750,001 more (one unit over) | `EExceedsLifetimeCap`: the cap is cumulative (dry run) |
| spending from an allowance by a key that is not its spender | refused before execution: `Transaction sender is not the spender of allowance …` |

**Limit: software passkeys.** The three passkeys are a minimal
software stand-in for a WebAuthn authenticator. They are P-256 keys that return
a DER public key on create, and authenticator data, client data JSON and a DER
signature on get, used through the SDK's own `PasskeyKeypair`. Sui's verifier
checks the passkey signature type, the challenge and the signature, and it
accepted them, so the protocol question is answered and Phase 1 Move work does
not depend on the difference.

What they do **not** prove: behaviour of real authenticators (attestation, the
user-verification step behind the UV flag they assert, synced-passkey BE/BS
flags, extra `clientDataJSON` keys some browsers add, high-S signatures; the SDK
normalises the last), and collecting partial signatures from three people on
three devices. They were not created on a phone, Windows Hello or a security
key.

The brief's literal path does not exist yet: `lib/wallet/sui-signers.ts` builds
one single-key `PasskeyKeypair` with `authenticatorAttachment: 'platform'`, and
has no `MultiSigPublicKey` or signature combining. So "a 2-of-3 of real
passkeys from `sui-signers.ts`" needs new code first. That code is Phase 2.1
(business wallet creation).

**Decided by Sky, 24 Oct 2026:** the software-passkey proof is accepted for
this gate. The hardware 2-of-3, through `sui-signers.ts`, is the first test of
Phase 2.1 (business wallet creation). It needs three people (or three
authenticators) and the multisig code.

The probe package (`experiments/v2-phase0/allowance_probe`, published at
`0xa21e6a5c70d2069ce13b57ace0f69cdf273550312ee306a9729f1010d8a4e82c`, digest
`9JqE2kAvwfPTzdrQvM4xVXXwgkUcsQwZjugoRmhBmGnT`) is a testnet-only stand-in for
`splash_spend`, written with no `rotate_spender` and no exported permit. After
the proof its `UpgradeCap` was destroyed with `package::make_immutable`
(`GAiRkVpsveHPrEsoW8KQjVDBqqZmaB84TinVdPWNqPCk`), so it can never change. It has
no unit tests and no security audit: it is scaffolding for this gate, never for
mainnet.

**Never fund the test multisig or the test keys on mainnet.** They are valid
mainnet addresses, and their keys sit in a plaintext file on one PC
(`~/splash-testnet-proof-key.json`, outside the repository). Delete that file
once the Phase 1 test vectors are captured.

## 4. SDK and CLI

- `@mysten/sui` is **2.31.3**, locked by `package-lock.json` (`package.json` says
  `^2.31.3`; npm's latest is 2.37.0). It ships `AllowanceBalance`,
  `SenderAllowance` and `tx.withdrawal({ from: 'allowance' })`, all used above,
  and the `PasskeyKeypair` / `PasskeyProvider` API.
- **`sui::allowance` first ships in Sui `mainnet-v1.80.1`.** Checked against
  `raw.githubusercontent.com/MystenLabs/sui/<tag>/crates/sui-framework/packages/sui-framework/sources/allowance.move`:
  404 at `mainnet-v1.77.2`, `v1.78.1` and `v1.79.1`; 200 at `v1.80.1`, `v1.81.1`
  and `v1.82.3`.
- **Pinned to `mainnet-v1.82.3`**, the latest mainnet release (21 Oct 2026),
  rather than the minimum. It matches the framework mainnet runs.
  - Installed at `%USERPROFILE%\.sui-cli\mainnet-v1.82.3\sui.exe`.
  - The release archive `sui-mainnet-v1.82.3-windows-x86_64.tgz` matched
    GitHub's published SHA-256
    (`d9d7c6887ff44f3ee957b87ab506669bab6aaa638f491cf2a9024ae720edaf8a`)
    before it was unpacked.
  - `sui.exe` itself hashes to
    `dc0adb2a48f63ed5bc6becf1f81f06eed8ce921021a1076acf49e6a2d7c53f7e`, and
    `sui --version` reports `1.82.3-bf4073918ed3`.
- The bare `sui` on `PATH` on this PC is still **1.77.2**, and it cannot build
  anything that uses `sui::allowance`. Use the full path above until `PATH` is
  updated.
- **The existing Move packages pass on 1.82.3**, run 24 Oct 2026 with the
  full path above: `splash_core` 94/94, `splash_meter` 23/23, `splash_custody`
  16/16. No `Move.lock` changed.
- **Nothing in the repository enforces the pin yet.** CI (`ci.yml`,
  `core-invariant.yml`) installs no Sui CLI and runs no Move tests, and
  `move/splash_custody/Move.toml` still says only "REQUIRES Sui CLI >= 1.61.1".
  Files under `move/` need Sebastian's approval, so the `>= 1.80.1` note goes
  into the Phase 1 pull request, which changes `move/` anyway.

## 5. CCTP V2 on Sui

Source: Circle, *CCTP Sui packages and interfaces*,
https://developers.circle.com/cctp/references/sui-packages, read 24 Oct 2026.
Sui is **domain 8**. **All 16 IDs resolved on chain** as the right kind of
object (`reads/03-cctp-v2.json`). The four packages are packages at version 1
(18, 18, 8 and 1 modules), the three state objects are shared
`<package>::state::State`, and each USDC Treasury is a shared
`treasury::Treasury<USDC>`.

| Network | Object | ID |
|---|---|---|
| Mainnet | MessageTransmitterV2 (package) | `0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87` |
| Mainnet | TokenMessengerMinterV2 (package) | `0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830` |
| Mainnet | StablecoinHandler (package) | `0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf` |
| Mainnet | CctpExtensions (package) | `0x194c593691aed72b23b967cacad967a93c0b17ff98180d417e91ac503ce3597d` |
| Mainnet | MessageTransmitterV2 state | `0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c` |
| Mainnet | TokenMessengerMinterV2 state | `0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167` |
| Mainnet | StablecoinHandler state | `0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41` |
| Mainnet | USDC Treasury (`Treasury<0xdba3…f900e7::usdc::USDC>`) | `0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7` |
| Testnet | MessageTransmitterV2 (package) | `0xe9678cd42a81886e18e21361088071f275105636a4d3751e1d7f255211f73bbe` |
| Testnet | TokenMessengerMinterV2 (package) | `0x267d3c0cb776eace2840f27e4d33da9c6d952f9749403f1fe6579f4962ed3c64` |
| Testnet | StablecoinHandler (package) | `0xbe8479044396a45e07de2c7f14789c35b8338406eebc53b2527da56839a91561` |
| Testnet | CctpExtensions (package) | `0x3cdb05f9a035c147410f5a9cfe2ccb741f4ab3cd59411e86714ce4b45e2c4d95` |
| Testnet | MessageTransmitterV2 state | `0xfee3a2b47f9ef2de2405fc63d79194307945f8ea768815cfc46083bc20fbe6ed` |
| Testnet | TokenMessengerMinterV2 state | `0x72cb55cd14d01e6361386d6ea93eecda9fa1efc3c202b8dd69c1e4683e4c0ca0` |
| Testnet | StablecoinHandler state | `0xfbd9c0517c4f0e1817445ee2be598806e3c392a465d7e3d773d1055f3f0eed32` |
| Testnet | USDC Treasury (`Treasury<0xa1ec…7e29::usdc::USDC>`) | `0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe` |

`CctpExtensions` has no state object on either network (Circle).

**Burn on Sui.** `deposit_for_burn::deposit_for_burn<T>` takes
`(Coin<T>, u32 destination_domain, address mint_recipient, address destination_caller, u256 max_fee, u32 min_finality_threshold, vector<u8> hook_data, &State, &mut TxContext)`
and returns `(BurnReceipt<T>, Coin<T>)`.

`BurnReceipt` and `CompleteBurnTicket` have **no abilities**, so the same PTB
must call `create_complete_burn_ticket` and then `complete_burn`, passing the
TokenMessengerMinterV2 and MessageTransmitterV2 `State` objects. That is how
Circle forces the burn to complete.

Two consequences for Phase 1:
- The burn takes a `Coin<USDC>`, and allowance spends return a `Balance<USDC>`,
  so a `coin::from_balance` step sits in between.
- Both CCTP packages have version control and migration entry points, so Circle
  can move to new versions. CCTP calls belong in the PTB or behind a seam that
  can change, never compiled into the immutable `splash_spend`.

**Fast Transfer.** Circle's *Supported blockchains and domains*
(https://developers.circle.com/cctp/concepts/supported-chains-and-domains)
gives the Sui row as:

| Source (Standard) | Source (Fast) | Source (Upfront fees) | Forwarding Service |
|---|---|---|---|
| ✅ | **N/A** | ❌ | ❌ |

N/A means Circle does not offer Fast Transfer where standard attestation is
already fast. **From Sui: no Fast Transfer** (standard is fast). **Into Sui:**
every listed chain is a destination, so Fast Transfer from chains marked ✅ as
a fast source (Ethereum, Base, Arbitrum, Solana and others) appears available.
That matters for D7 funding via CCTP; confirm with Circle before relying on it.

As D13 warns, Circle's site still carries one contradicting line: its generic
guidance text says "Noble, Sui, and Aptos still require V1". The Sui packages
page and the on-chain packages are V2.

## 6. Partner USDC deposit networks

Hata (MY), PDAX (PH), Tokocrypto (ID), Bitkub (TH): **ask partner.** None of
them publishes an authoritative per-network deposit list we can cite, and the
brief allows this item to stay open.

## Findings for Phase 1 and 2

From `allowance.move` at `mainnet-v1.82.3`, from the protocol, and from the
proof:

1. **The funder is the transaction sender.** `new` and `propose_for_app` record
   `ctx.sender()` as the funder. The business multisig signs every allowance it
   funds, and Splash cannot create one on a business's behalf.
2. **The revoke key belongs to the funder.** `issue` shares the `Allowance` and
   sends the `AllowanceCap` to the funder. Revoking needs both, so only the
   business can revoke.
3. **A signer change moves the funder.** A Sui multisig address is the hash of
   its members, weights and threshold, so adding or removing a signer (D1)
   gives a new address. Every existing allowance, its `AllowanceCap` and the
   address balance stay at the old address, and revoking still needs the old
   signer set. `rotate_wallet` (§3.2 of the brief) must therefore revoke all
   allowances from the old wallet, move the balance, and re-propose from the
   new wallet, in that order.
4. **Withdrawals come from the funder's address balance.** Funds held as coin
   objects cannot be spent through an allowance, which fits D1's "funds sit in
   the business's own address balances". Deposits that arrive as coins must be
   moved into the address balance.
5. **One spender per allowance.** The spender is a single address, and
   `splash_spend` may not rotate it (no `rotate_spender`). A staff key change is
   therefore revoke plus a new proposal signed by the business. Scheduled
   payments need their own allowance whose spender is the KMS operator.
6. **The spender check binds an address, not a key.** `consume` checks
   `ctx.sender() == spender`, and `address_aliases = true` on mainnet:
   `0x2::address_alias` (private `entry` `enable` and `add`) lets an address
   authorise other keys to send as it. So "no `rotate_spender` in
   `splash_spend`" stops the app from changing who the spender is. It does not
   stop a spender aliasing their own address to another key. Phase 1/2 must
   decide whether that is acceptable for staff spenders.
   More important: **the business multisig must never sign `address_alias`
   calls.** An alias on the wallet would let another key act as the wallet, and
   so as the funder of every allowance. The wallet code should refuse to build
   them and alert if one appears.
7. **An immutable app is fixed forever.** The app is recorded as
   `type_name::with_defining_ids<SPLASH_SPEND>()`. With `splash_spend` immutable,
   any re-publish (a bug fix) is a new app type, and every existing app-bound
   allowance is orphaned until each business re-proposes. Phase 1 should treat
   `splash_spend` as small and final, and plan the migration path anyway.
8. **Only the app module can make its permits.** `SettingsPermit<App>` and
   `SpendPermit<App>` come only from `internal::permit<App>()`, which only the
   module that defines `App` can call. The testnet probe makes both inside its
   functions and returns neither.
9. **Sponsorship.** Sponsoring the gas of a spender's transaction works (proved
   above). Sponsor-bound withdrawals do not (`ESponsorWithdrawalNotEnabled`).
10. **Limits are required.** An allowance must have a lifetime cap or a rate
    limit, and an expiry or a rate limit (`ENoLimit`, `ENoExpiration`). Caps are
    `u256` in minor units (USDC has 6 decimals).
11. **Gasless withdrawals** of USDC by the multisig worked on testnet (§2).

## Phase 1 can start

Everything Phase 1's Move work depends on is proven on chain. Hardware passkeys
through `sui-signers.ts` are Phase 2.1 work and do not change any Move design.
