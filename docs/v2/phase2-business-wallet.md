# v2 Phase 2 §4.1: the Business Splash Wallet backend

Spec: `SPLASH_SUI_V2_PROMPT.md` §4.1 and decision D1; review items B4, B9 and
B10 of `SPLASH_SUI_V2_CODE_REVIEW.md`. It builds on the Phase 1 Move API
(`docs/v2/phase1-move-design.md` §1–§3): `business_account::nominate_wallet`,
`register_wallet`, `rotate_wallet`, `confirm_wallet_rotation`, the wallet-only
membership calls, and `payment_intent::create_for_wallet` with
`confirm_from_business_wallet_balance` (max_fee, FeeConfig, Registry; A1). The
UI that drives it is Phase 3.

## Modules

| File | What it does |
|---|---|
| `lib/wallet/business-multisig.ts` | Owners' passkeys to a `MultiSigPublicKey`, with Move's rules: 1–10 members, no key twice, weights 1–255, threshold 1..sum. 2-of-N by default. Single-signer (any one weight reaches the threshold) only when the business chose it. Isomorphic. |
| `lib/server/sui-v2-builders.ts` | The v2 PTBs: nominate (adding the members as owners first), register, rotate, confirm and cancel rotation, membership, pay (open + pay + anchor + delete in one PTB), pay an existing intent, and a plain USDC transfer (migration, rotation). Offline: shared objects by initial version, so the same bytes are shown, hashed, signed, simulated and submitted. Replaces the v1 builders in `lib/server/sui-settlement.ts` for v2; those stay, V1 TESTNET ONLY, refused on mainnet. |
| `lib/wallet/wallet-tx-describe.ts` | Decodes exact bytes into what they do (review B10) and refuses anything else (below). Isomorphic. |
| `lib/wallet/review-on-device.ts` | What a signer's device runs on the bytes it received: decode them itself, check the digest and hash, and show a 16-hex transaction code. The signing screen renders this, never the server's decoding. |
| `lib/server/wallet-sponsor.ts` | Who pays gas. `assertSponsorable` is checked on the bytes before the sponsor signs. |
| `lib/server/wallet-signing.ts` + `-store.ts` | Signature collection: open, sign, decline, combine, submit, expire, cancel, reconcile. Postgres, migrations 0033 and 0034. |
| `lib/server/business-wallet.ts` | The flows: plan (who is in the wallet), create (nominate, then register), rotate (propose, confirm, move the old wallet's USDC), membership, pay, pay an existing intent, migrate. |
| `lib/server/wallet-members.ts` | Which passkey stands for which owner, and who the founder is (the account's on-chain `owner`). |
| `lib/server/wallet-network-gate.ts` | No wallet request on mainnet until the hardware check is recorded. |
| `lib/server/wallet-deps.ts` | The live wiring for one org, including reading the BusinessAccount and intents from the chain. |
| `lib/server/approval-requests.ts` | The WhatsApp message for a wallet signature request. |
| `app/api/wallet/*`, `app/api/cron/wallet-signing` | Routes for Phase 3, and the sweep and reconcile. |

## Who is in the wallet

- **Owners** are the org's members with role admin. Each signs with their one
  active passkey on this site (Postgres allows one per person per site,
  migration 0005). An owner with none is **not dropped silently**: the wallet
  is refused (`owners_without_passkey`, with who) until the founder names them
  in `confirmExcluded`.
- **The founder** is the BusinessAccount's on-chain `owner`, read from the
  chain, the only address `nominate_wallet` accepts. It is not guessed from
  memberships.
- **On-chain owners.** `register_wallet` refuses a member whose own passkey
  address is not an owner of the account (E_SIGNER_NOT_AN_OWNER). Before a
  wallet registers any owner may add one, so the founder's nomination adds
  every missing member with `add_owner`, then nominates, in one transaction.
  The reader allows only wallet members there.
- **Single signer (D1).** A wallet one member can sign alone is built only
  when the business chose it. With more than one owner, every other owner
  must first agree to that exact wallet address
  (`POST /api/wallet/business/consent`, table `wallet_single_signer_consents`).
  A new owner, a changed passkey or another threshold is another address, and
  needs consent again.
- **The current wallet** is what `BusinessAccount.wallet` says on chain. Its
  members come from the executed registration or confirmation that set it up;
  a wallet the chain names that Splash has no record of is refused.

## Signature collection

1. **Open.** The server builds the bytes, decodes them, checks that they have
   the shape the purpose allows, that the sender is the signer named, that the
   sponsor will pay for them, that the org is inside its sponsored-gas budget
   (1 SUI per 24 hours), and that they **simulate**. Only then are they stored,
   with their digest and the decoded description, and each signer told:
   WhatsApp (no link, no bytes; a 16-hex transaction code to compare) and the
   in-app inbox (`GET /api/wallet/signing-requests`). Routes that open a
   request are rate-limited per person and per business.
2. **Sign.** A signer fetches the request and their device decodes the bytes
   itself (`reviewOnDevice`), signs **those bytes** with their own passkey and
   posts the partial signature with the digest they reviewed. Refused: a
   digest that is not the request's (409), a user who is not a signer (403),
   another org's request (404), a second signature from one signer (409), a
   signer who declined (409), a signature that does not verify over the stored
   bytes under that signer's own key (400), a whole multisig signature in
   place of a part, a request whose bytes no longer decode (409), and any
   expired or closed request (410/409).
3. **Decline or cancel.** Only the person who asked can withdraw a request.
   Any other signer declines (`DELETE /api/wallet/signing-requests/:id`): that
   is recorded, the request leaves their inbox and stays open for the others,
   and it closes only when the signers left cannot reach the threshold. So no
   one key can veto the quorum, for example to block their own rotation out.
4. **Submit.** At the threshold one caller claims the submission (a guarded
   UPDATE that records `claimed_at`), the partials are sorted into member order
   and combined, the result is verified against the multisig key, the bytes are
   decoded, checked by the sponsor and simulated again, the sponsor signs, and
   the transaction executes.
5. **Outcome.** Executed or failed on chain, the request closes, and an
   executed one opens its follow-up step. If the network does not answer (a
   timeout, a crash, a redeploy), the digest is read back; if the chain has
   not seen it, the request is **unknown**, not failed: it keeps its digest and
   its dedupe key and holds no partial signature.
6. **Reconcile.** `/api/cron/wallet-signing` (every few minutes) closes
   collecting requests past their expiry, and reads by digest every unknown
   request and every one still submitting past a 5-minute lease. Found: it
   closes as executed or failed, and an executed one runs its follow-up step
   with its own org's context. Not found and past its ValidDuring window: it
   closes as failed, since those bytes can never land; only then is its dedupe
   key free. The cron answers 502 while any partial signature is held for a
   request that is no longer open, any submission is stuck past the lease, or
   a chain read failed.

Expiry: at most 24 hours, and never after a payment's `settle_by_ms` (the
quote). On chain, every wallet transaction carries a ValidDuring window of
the epoch it was built in and the next.

Nothing logs a signature. Partial signatures are stored as sent (they are not
secrets, and the combined signature is public once executed), only while the
request is collecting or being submitted.

## What the reader refuses

Every command outside: the v2 `splash_core` wallet and payment calls,
`0x2::balance::{redeem_funds, send_funds, join}`, `0x2::coin::into_balance`
and `MergeCoins` of the sender's own coins. So, refused: any
`0x2::address_alias` call (Phase 0 finding 6), any other package, Publish,
Upgrade, TransferObjects, SplitCoins, MakeMoveVec, any use of the gas coin,
any withdrawal from the sponsor's or an allowance's balance, an object that
is not this org's account or the configured config, fee config and registry,
a Receiving input, and any asset but native USDC.

**An existing intent** (a staff member's, over their spending rule) is named
in the bytes only by its object id. The reader refuses it unless the server
read the intent from the chain first and bound its id, payee, principal,
kind, rate, expiry and asset into the request (`expect.openIntent`, stored
with it). The withdrawal must then be exactly principal plus max_fee, the
quote cannot outlive the intent, and every signer sees the payee and amount.
The intent must be this org's, pending and unexpired; another org's reads as
absent.

## Gas

The wallet holds no SUI.

- **Plain transfers** (the migration, and the old wallet's funds after a
  rotation) go through Sui's gasless stablecoin lane, the existing
  `STABLECOIN_GASLESS` path: gas price 0, no gas coin.
- **Move calls** are outside that lane, so Splash sponsors them
  (`WALLET_GAS_SPONSOR=operator`): the gas owner is the operator signer (KMS
  in production), paying from its SUI **address balance**, never a gas coin,
  so no command can take one. The budget is capped at 0.05 SUI per
  transaction and 1 SUI per org per 24 hours. Before signing, the sponsor
  checks on the bytes that it is the gas owner, the sender is the request's,
  and the reader accepts the transaction. The sponsor pays gas only, and never
  pays or receives client money (D3).

The operator's SUI address balance must be funded before the first wallet
transaction (`docs/MAINNET-CHECKLIST.md`). Whether a sponsored transaction may
pay gas from the sponsor's address balance is to be confirmed by a testnet
dry run (open item below).

## Rotation

`POST /api/wallet/business/rotation`: an owner proposes the wallet today's
owners' passkeys make (the same rules as creating one). The current wallet's
quorum signs `rotate_wallet`; when that lands, the new wallet's quorum is
asked to confirm; when the confirmation lands, the old wallet's quorum is
asked to move its whole USDC address balance to the new wallet (nothing is
asked if it holds none). `DELETE` withdraws a rotation not yet confirmed.
Allowances the old wallet funded name it as funder; they are revoked and
reissued with the spending rules (§4.2), which are not built yet.

Membership: `POST /api/wallet/business/members` (add or remove an owner by
their membership here, remove an owner or set the recovery party by
address), signed by the wallet.

## Migration from the per-person passkey wallets

`GET /api/wallet/migration` reads, read-only, the USDC at every passkey
address of every member of the business: owners and staff, and revoked or
other-site passkeys too (`canMove` is false for those; their holder moves
them from the site the passkey belongs to). `POST` builds the signed-in
member's own transfer of what their active passkey wallet here holds: their
coin objects (read page by page, at most 250 per transfer; `more` says to run
it again) merged and turned into a balance, their address balance redeemed,
one `send_funds` to the wallet the BusinessAccount names. They sign it alone
(Sky's decision: plain signed transfers). Gasless; sponsored only if
`STABLECOIN_GASLESS=off`.

## Mainnet

No wallet request is built on mainnet unless `WALLET_MAINNET_ENABLED=true`
and `WALLET_HARDWARE_CHECK_REF` names where the hardware check's evidence is
recorded (for example `docs/mainnet-checks-2026-10.md#wallet-2-of-3`).
Production refuses to boot on mainnet with the switch on and no reference.

## Runbook: the hardware 2-of-3

Owed from Phase 0 (`docs/mainnet-checks-2026-10.md`): the gate used software
passkeys. This needs three people, or three authenticators, on the testnet
deployment. No agent can do it.

1. Three owners of one testnet business each enrol a passkey on a different
   kind of device: a phone (iCloud Keychain or Google Password Manager), a
   laptop (Windows Hello or Touch ID), a security key. Note which is which.
2. The founder starts the wallet (`POST /api/wallet/business`) and signs the
   nomination on their device. Record the request digest.
3. Two of the three sign the registration on their own devices, from the
   inbox. Before signing, each compares the transaction code in WhatsApp with
   the one on screen.
4. Save the registration's `transactionBytes`, the three public keys and the
   two partial signatures (from `wallet_signing_signers` before the request
   closes, or from the devices' outputs) as `evidence.json`, and run
   `node scripts/wallet-hardware-check.mjs evidence.json --dry-run`. It
   checks each signature, combines them as the server does and asks a testnet
   fullnode to simulate. It never submits.
5. Let the server submit (it does at the threshold). Record the executed
   digest, the wallet address, the three device kinds and the script output in
   `docs/mainnet-checks-2026-10.md` under a `wallet-2-of-3` heading, and set
   `WALLET_HARDWARE_CHECK_REF` to it.

The check passes when the registration executes on testnet from two hardware
passkeys. Until then, business wallets stay off mainnet (in code, above).

## Open, not built here

- **The hardware 2-of-3** above: needs people with devices.
- **Testnet dry runs** of a sponsored transaction paying gas from an address
  balance (`gasData.payment = []`, another gas owner) and of the migration PTB
  in the gasless lane. Simulation before signing refuses a request if either
  is not accepted, so nothing is signed for a shape the chain rejects.
- **Payment routes.** `requestWalletPayment` and `requestOpenIntentPayment`
  are built and tested, but no route calls them yet: a payment needs its
  audit bundle on Walrus (`contentHash`, `walrusBlobId`), its commitments and
  a quote, which the Transfer flow composes (§5.4 step 4) with the payout
  partners (§4.5). Which roles may ask the owners to sign a payment is Sky's
  decision.
- **zkLogin members** (the D1 fallback): a zkLogin partial signature needs a
  proof per epoch; `buildBusinessMultisig` takes passkeys only.
- **The address-alias watcher**: the builder and reader refuse alias commands;
  a watcher that alerts if an `AddressAliases` object appears for a wallet, the
  governance multisig or the operator is not built.
- **Cross-chain payments from the wallet**: no bridge adapter is registered
  (Phase 1), so the builders refuse kind 3.
- **Allowances after a rotation**: revoke and reissue with the spending rules
  (§4.2).
- **The UI** (Phase 3): the signing screen must render `reviewOnDevice` on the
  bytes, with full addresses and the transaction code.
