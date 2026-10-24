# v2 Phase 2 §4.1: the Business Splash Wallet backend

Spec: `SPLASH_SUI_V2_PROMPT.md` §4.1 and decision D1; review items B9 and B10
of `SPLASH_SUI_V2_CODE_REVIEW.md`. It builds on the Phase 1 Move API
(`docs/v2/phase1-move-design.md` §1–§3): `business_account::nominate_wallet`,
`register_wallet`, `rotate_wallet`, `confirm_wallet_rotation`, the wallet-only
membership calls, and `payment_intent::create_for_wallet` with
`confirm_from_business_wallet_balance` (max_fee, FeeConfig, Registry; A1). The
UI that drives it is Phase 3.

## Modules

| File | What it does |
|---|---|
| `lib/wallet/business-multisig.ts` | Owners' passkeys to a `MultiSigPublicKey`, with Move's rules: 1–10 members, no key twice, weights 1–255, threshold 1..sum. 2-of-N by default. Single-signer (any one weight reaches the threshold) only when the business chose it. Isomorphic. |
| `lib/server/sui-v2-builders.ts` | The v2 PTBs: nominate, register, rotate, confirm and cancel rotation, membership, pay (open + pay + anchor + delete in one PTB), pay an open intent, and a member's migration transfer. Offline: shared objects by initial version, so the same bytes are shown, hashed, signed, simulated and submitted. Replaces the v1 builders in `lib/server/sui-settlement.ts` for v2; those stay, V1 TESTNET ONLY, refused on mainnet. |
| `lib/wallet/wallet-tx-describe.ts` | Decodes exact bytes into what they do (review B10) and refuses anything else (below). Isomorphic, so a signer's device can decode the bytes it received and compare. |
| `lib/server/wallet-sponsor.ts` | Who pays gas. `assertSponsorable` is checked on the bytes before the sponsor signs. |
| `lib/server/wallet-signing.ts` + `-store.ts` | Signature collection: open, sign, combine, submit, expire, cancel. Postgres, migration 0033. |
| `lib/server/business-wallet.ts` | The flows: create (nominate, then register), rotate (propose, then confirm), membership, pay, migrate. |
| `lib/server/approval-requests.ts` | Adds the WhatsApp message for a wallet signature request. |
| `app/api/wallet/*`, `app/api/cron/wallet-signing` | Routes for Phase 3, and the expiry sweep. |

## Signature collection

1. **Open.** The server builds the bytes, decodes them, checks that they have
   the shape the purpose allows, that the sender is the signer named, that the
   sponsor will pay for them, and that they **simulate**. Only then are they
   stored, with their digest and the decoded description, and each signer
   told: WhatsApp (no code, no link, no bytes; a short hash of the bytes to
   compare) and the in-app inbox (`GET /api/wallet/signing-requests`).
2. **Sign.** A signer fetches the request (bytes, digest, decoded description,
   the dry run's balance changes), signs **those bytes** with their own passkey
   (`signWithPasskey` in `lib/wallet/sui-signers.ts`) and posts the partial
   signature with the digest they reviewed. Refused: a digest that is not the
   request's (409), a user who is not a signer (403), another org's request
   (404), a second signature from one signer (409), a signature that does not
   verify over the stored bytes under that signer's own key (400, which is how
   tampered bytes and borrowed keys fail), a whole multisig signature in place
   of a part, and any expired or closed request (410/409).
3. **Submit.** At the threshold one caller claims the submission (a guarded
   UPDATE), the partials are sorted into member order and combined
   (`combinePartialSignatures`), the result is verified against the multisig
   key, the bytes are decoded, checked by the sponsor and simulated again, the
   sponsor signs, and the transaction executes. A timeout reads the digest
   back before deciding.
4. **Close.** Executed, failed, expired or cancelled, the statement that
   closes a request clears every partial signature it held; a SHA-256 of each
   stays as evidence. `/api/cron/wallet-signing` closes requests past their
   expiry and answers 502 if any signature is still held for a closed request.

Expiry: at most 24 hours, and never after a payment's `settle_by_ms` (the
quote). On chain, every wallet transaction carries a ValidDuring window of
the epoch it was built in and the next.

Nothing logs a signature. Partial signatures are stored as sent (they are not
secrets, and the combined signature is public once executed), only while the
request is open.

## What the reader refuses

Every command outside: the v2 `splash_core` wallet and payment calls,
`0x2::balance::{redeem_funds, send_funds, join}`, `0x2::coin::into_balance`
and `MergeCoins` of the sender's own coins. So, refused: any
`0x2::address_alias` call (Phase 0 finding 6), any other package, Publish,
Upgrade, TransferObjects, SplitCoins, MakeMoveVec, any use of the gas coin,
any withdrawal from the sponsor's or an allowance's balance, an object that
is not this org's account or the configured config, fee config and registry,
a Receiving input, and any asset but native USDC.

## Gas

The wallet holds no SUI.

- **Plain transfers** (the migration) go through Sui's gasless stablecoin
  lane, the existing `STABLECOIN_GASLESS` path: gas price 0, no gas coin.
- **Move calls** are outside that lane, so Splash sponsors them
  (`WALLET_GAS_SPONSOR=operator`): the gas owner is the operator signer (KMS
  in production), paying from its SUI **address balance**, never a gas coin,
  so no command can take one. The budget is capped at 0.05 SUI. Before
  signing, the sponsor checks on the bytes that it is the gas owner, the
  sender is the request's, and the reader accepts the transaction. The
  sponsor pays gas only, and never pays or receives client money (D3).

The operator's SUI address balance must be funded before the first wallet
transaction (`docs/MAINNET-CHECKLIST.md`). Whether a sponsored transaction may
pay gas from the sponsor's address balance on mainnet is to be confirmed by a
testnet dry run (open item below).

## Migration from the per-person passkey wallets

`GET /api/wallet/migration` reads, read-only, the USDC at each owner's own
passkey address. `POST` builds the signed-in owner's own transfer of all of
it to the business wallet: their coin objects merged and turned into a
balance, their address balance redeemed, one `send_funds`. They sign it
alone (Sky's decision: plain signed transfers). Gasless; sponsored only if
`STABLECOIN_GASLESS=off`.

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
   inbox. Before signing, each compares the short code in WhatsApp with the
   one on screen.
4. Save the registration's `transactionBytes`, the three public keys and the
   two partial signatures (from `wallet_signing_signers` before the request
   closes, or from the devices' outputs) as `evidence.json`, and run
   `node scripts/wallet-hardware-check.mjs evidence.json --dry-run`. It
   checks each signature, combines them as the server does and asks a testnet
   fullnode to simulate. It never submits.
5. Let the server submit (it does at the threshold). Record the executed
   digest, the wallet address, the three device kinds and the script output in
   `docs/mainnet-checks-2026-10.md` under check 3.

The check passes when the registration executes on testnet from two hardware
passkeys. Until then, mainnet onboarding of business wallets waits.

## Open, not built here

- **The hardware 2-of-3** above: needs people with devices.
- **zkLogin members** (the D1 fallback): a zkLogin partial signature needs a
  proof per epoch; `buildBusinessMultisig` takes passkeys only.
- **The address-alias watcher**: the builder and reader refuse alias commands;
  a watcher that alerts if an `AddressAliases` object appears for a wallet, the
  governance multisig or the operator is not built.
- **Cross-chain payments from the wallet**: no bridge adapter is registered
  (Phase 1), so `payFromWalletTx` refuses kind 3.
- **Sponsor gas from an address balance on mainnet** is to be confirmed by a
  testnet dry run before `WALLET_GAS_SPONSOR=operator` is set anywhere.
- **The UI** (Phase 3) and wiring a staff intent's owner payment
  (`payOpenIntentFromWalletTx`) to a route.
