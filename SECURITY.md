# Splash Protocol — Security Audit & Monitoring Report

**Scope**: All Move modules under `move/sources/` (8 modules)
**Methodology**: OtterSec-style review — capability access control, resource handling, integer arithmetic, authorization, event traceability, upgrade & pause posture, Move-specific patterns (hot-potato, abilities, UID hygiene).
**Audit date**: 2026-05-29
**Audited build**: `move/sources/` at HEAD (post `fee_bps` parameterization)
**Reviewer**: Splash engineering — internal pre-production sweep

---

## Executive Summary

| Severity      | Count | Status (truth pass 2026-07-02) |
| ------------- | ----- | -------------------------------- |
| Critical      | 3     | **3 Open**                       |
| High          | 6     | 1 Fixed (H-06) / **5 Open**      |
| Medium        | 8     | **8 Open**                       |
| Low           | 6     | **6 Open / advisory**            |
| Informational | 4     | Convention / housekeeping        |

**Truth-pass correction:** the prior summary overstated scaffold remediation.
No Phase A Move rewrites have shipped in this branch. The detailed findings
below are the source of truth until the named Move modules are rewritten and
their tests pass. The only previously verified fixed item retained here is
H-06 fee-bps parameterization.

The protocol cleanly separates settlement, peg monitoring, business identity, and dual-stablecoin TTL handling — those four modules (`settlement`, `peg_monitor`, `business_account`, `dual_treasury`) are well-structured and resource-safe.

The remaining four modules (`smart_treasury`, `payment_intent`, `audit_anchor`, `receipt_v2`) are explicitly labelled "Phase 1 scaffold" in their headers. They are **not production-grade** in their current form — `smart_treasury::add_usdc` is fundamentally broken, `payment_intent::create_payment_intent` accepts spoofed sender addresses, and several functions have no authorization at all. **Do not publish these scaffold modules to mainnet** without rewriting.

---

## v2 Phase 2 §4.5 — payout partners behind one interface — 2026-10-25

Design: `docs/v2/phase2-payout-partners.md`. Tests:
`tests/payout-partners.test.mjs`, `tests/partner-payouts.test.mjs`.

- **One interface, four routes.** `pdax` (PH), `durianpay` (ID, with its
  exchange partner), `hata_fiuu` (MY own bank) and `cctp_wallet` (USDC to
  another chain over CCTP V2) each have quote, createPayout (keyed by the
  intent id), status, handleWebhook and returnOrReverse. The sandbox runs
  outside production only; in production each refuses without its
  credentials and, with them, until its API is wired. `cctp_wallet` refuses
  in production with credentials too: no bridge adapter is registered on
  chain, so no cross-chain intent can settle.
- **Fixed before this section:** `lib/server/pdax.ts` chose its mock
  whenever `PDAX_API_KEY` was unset, in production too, and the mock made a
  `DEMO_PDAX_…` payout reference. The v1 sweep could therefore record a
  fabricated payout in production. The selection is now the runtime mode
  alone; the v1 sweep refuses in production and names a `sandbox_pdax_…`
  reference outside it. The quote engine's partner fee comes from the same
  adapter and is null in production until the partner quotes.
- **Supplier payouts ride the withdrawal rails.** The same composed PTB
  (kind 4, straight to the business's verified deposit address with that
  partner, one per business per partner), the same instruction before
  money, the same digest-after-settlement check, webhooks, return rules,
  unique indexes and sweep. The owners sign under `partner_payout` and are
  shown the supplier; the server re-checks the account and holder before
  every signature.
- **The supplier's account.** Stored only when the bank's own holder name
  is the name given; the business's own name is refused (that is a
  withdrawal). The account, the salt and the supplier's ISO 20022 party
  (structured address, registration number) are sealed, bound to the org
  and row. A supplier and an own account are never paid through each
  other's path.
- **ISO 20022.** Every bank instruction carries a pacs.008-style message
  built from the very account the intent commits to; each adapter refuses
  one that names another intent, amount, account, holder, bank, deposit,
  commitment or purpose. The row keeps the masked evidence form only (last
  four digits; town and country of the address). A supplier payout needs
  the payer's KYB profile complete (`originator_incomplete` otherwise).
- **Review fixes (p2-4.5).** High: a staff draft of kind 4 (or any kind)
  to the business's partner deposit address could be accepted by an owner
  and paid as a plain `wallet_payment`, with no instruction to the partner
  first. Now a bank payout, or any payment to a partner deposit address of
  the business, is refused with `use_payout_route` in
  `requestWalletPayment`, `requestOpenIntentPayment`, the ask and accept
  paths, and the `wallet_payment` shape check. Medium: a name with `&` or
  an accented letter blocked every withdrawal (`bad_iso20022`): the CBPR+
  extended characters are accepted and the business's own text is
  transliterated and flagged. Medium: nothing wrote the registered address
  a supplier payout's originator needs: the owner's profile save takes the
  structured address. Low: a spending rule binds only this business's own
  verified bank accounts, each to its own partner's deposit address; the
  adapter check also binds the settlement amount, rate, minimum, debtor and
  charges; registration numbers are masked in the stored evidence and
  viewers do not read payouts; the dev sweep quotes by currency; each
  sandbox route has its own webhook secret.
- **Open:** name screening of a supplier (§4.6); the live partner APIs;
  Circle's fee API and the bridge adapter for `cctp_wallet`. A staff member
  holding a spending rule that binds a beneficiary can still open and pay a
  kind 4 intent from their own device under that rule (Move permits it);
  Splash does not build or sponsor that path, and the partner gets no
  instruction for it, so bind beneficiaries in rules only once a staff
  payout route exists.

## v2 Phase 2 §4.4 — withdrawals to the business's own bank — 2026-10-25

Design: `docs/v2/phase2-withdrawals.md`. Tests: `tests/withdrawals.test.mjs`.

- **No Splash account on the path (D3).** MYR goes business wallet → the
  business's own deposit address at Hata → Fiuu → the business's bank. The
  USDC leaves in the canonical composed PTB (open, pay, anchor, delete),
  kind 4, signed by the owners' multisig. A deposit address that is a Splash
  address (operator, sponsor, treasury, test recipient, and FeeConfig's fee
  recipient and pending recipient read live, failing closed), the wallet
  itself, another business's wallet or another business's address is
  refused. A return goes to the business wallet only. It counts only when
  the chain shows it sent by the deposit address into the wallet, by a
  digest no other withdrawal used (unique index); only the whole amount
  closes a withdrawal, and a short return is held for review.
- **Own account only.** A destination is stored only when the name given
  and the bank's own holder name (the partner's name enquiry) both match
  the registered legal name, and that name counts only once KYB verified it
  (kyb_status basic or full). Only an owner may set it, and it is fixed once
  KYB is under way; a change before that revokes every bank account and
  cancels withdrawals not yet sent. The trading name is not accepted. The
  account number and the beneficiary salt are AES-256-GCM sealed under
  `WITHDRAWAL_ACCOUNT_KEY` (rotatable through
  `WITHDRAWAL_ACCOUNT_KEY_PREVIOUS`), bound to the org and the row. Views
  and the trail carry the last four digits only.
- **Deposit address verified once.** A 1 USDC test deposit is signed by the
  owners (`partner_test_deposit`, bound to that address and amount). The
  address is verified only when the partner's signed confirmation names that
  digest and the chain shows that amount from the wallet. A spending rule
  binds a beneficiary only to a verified address.
- **Instruction before money, bound to the intent.** The partner is told
  first. The instruction is keyed by the intent id derived from the payment
  reference and by the expected amount. It is built from the sealed account
  only after its commitment is recomputed and matches the intent's
  `beneficiary_ref` (`beneficiary_mismatch` otherwise). The owners' request
  (`withdrawal`) accepts only a kind 4 payout to that address, for that
  beneficiary and amount. It carries the bank code, last four digits,
  holder, receive amounts, rate and deadline the signers are shown, and the
  server checks them against the stored account before every signature
  (`withdrawal_changed`). Removing the account cancels its withdrawals not
  yet sent. When the request cannot be opened, closes unsigned, or the
  partner's answer to the instruction is lost, the instruction is reversed.
  The partner gets the beneficiary salt, so it can check `beneficiary_ref`
  against the account it pays.
- **The intent id.** Production requires `SPLASH_CORE_ORIGINAL_PACKAGE_ID`
  (no fallback). Two Move tests pin the derivation. The digest is posted to
  the partner only after the executed transaction's `IntentCreated` event
  names the instructed intent id; a mismatch is held and alerted, never
  posted.
- **The signing window.** `settle_by` is the 24-hour signing deadline, not
  the 5-minute quote. The partner is told the least the account must
  receive; below it, it returns the USDC.
- **Quote and fee.** The quote is given only once the wallet holds principal
  plus fee outside holds. A worse rate (`quote_changed`), a fee above the one
  shown (`fee_above_shown`) or a fee over the 1% ceiling is refused. Partner
  fees are their own lines. Splash's fee is the chain's kind 4 fee, bounded
  by `max_fee`.
- **Webhooks.** The raw body's HMAC is checked first, inside a 5-minute
  window. Each event id counts once. An event must match the intent id and
  the partner's reference. Statuses never regress.
- **Idempotency.** Unique client key, intent id, payment reference, partner
  reference and Sui digest. A key reused for another request is refused.
- **Fail closed.** The partner is a sandbox outside production only
  (`isProductionRuntime`; `USE_MOCK_APIS` does not bring it back). In
  production it refuses without credentials and, until the API is wired,
  with them. Outside production the sandbox still refuses on a server
  pointed at mainnet. The sandbox webhook secret is random, at least 32
  characters, with no fallback.
- **Tenant isolation.** Routes sit behind `walletRoute` (session org).
  Owners alone change bank accounts and the deposit address; a staff member
  may ask for a withdrawal, which only the owners' quorum signs. Every store
  call takes the org; the sweep (`/api/cron/withdrawals`, `CRON_SECRET`)
  acts on each row within its own org. Reads never call the partner.
  Another org's ids read as 404.
- **Open:** the live Hata and Fiuu APIs and their webhook payloads; a
  scheduled run that posts unposted digests (today: on the executed hook and
  on every read); rotation of `WITHDRAWAL_ACCOUNT_KEY`.

## v2 Phase 2 §4.3 — funding the Business Splash Wallet — 2026-10-25

Design: `docs/v2/phase2-funding.md`.

- **One destination.** Every channel (funding partner, any Sui wallet, CCTP
  V2, swap routes) delivers to the wallet the business's `BusinessAccount`
  names on chain, read per request; the request never names it, and an
  address Splash controls is refused as destination and as source (D1, D3).
  The Phase 1 mainnet refusals on the old deposit-address path are unchanged.
- **Arrivals come from the chain.** A deposit is recorded from a transaction's
  balance changes to the business wallet, by digest, once per transaction and
  coin (unique index). A webhook or a request can name a digest, never an
  amount.
- **Screened on arrival, held when unverified.** Every deposit's origin is
  screened (`lib/compliance/kyt.ts`); a sanctions hit is blocked for good; an
  unknown, unverified, first-use-failed or mismatched source, or no verdict,
  holds it. Splash builds no wallet payment that would spend held or blocked
  USDC (`funds_on_hold`).
- **Sources.** A bank account or card only in the company's registered name;
  no full account or card number stored. A wallet is proven by a single-use,
  15-minute signed message naming the business, chain, address and nonce.
  First use is checked once.
- **Quote first; peg guard.** A fresh quote below the accepted one is refused.
  USDT / USDsui convert only within 30 bps (`peg_monitor`'s tolerance) on the
  coin's own DeepBook pool; no reading refuses.
- **Fail closed.** Partners, routes and Elliptic are sandboxes outside
  production and refuse in production (without credentials, and until their
  APIs are wired, with them). No verdict without a provider's answer.
- **Webhooks.** HMAC over the raw body, 5-minute replay window, matched by
  intent id and the partner's order reference, once per event id, no status
  regressions.
- **Tenant isolation.** Every route behind `walletRoute` (session org,
  `requireSessionAccount`); every store call takes the org; another org's
  ids read as 404. Owners alone change funding sources; viewers only read.
- **Open:** live partner, route and Elliptic APIs; the conversion signing
  request; EVM wallet proofs; holds do not bind a staff member's own
  allowance spend.

### Independent review of §4.3 — 2026-10-25

Regression tests: `tests/wallet-funding-review.test.mjs` (red commit first),
plus the second-approval case in `tests/spend-rules.test.mjs`. Migration
`0039_wallet_funding_review`.

| # | Severity | Finding | Status |
|---|---|---|---|
| F-1 | Critical | A CCTP mint credited the whole transaction's USDC inflow to the verified burner, so USDC a sanctioned relayer added in the same PTB cleared. **Fixed**: `cctpMint` credits the burner only from exactly one Circle `MessageReceived`, only when the burn's `mintRecipient` is the wallet, and only up to `amount - feeExecuted`; the rest is a separate `remainder` deposit attributed to the transaction sender and screened as the sender's. Two mints, another recipient or an unreadable body credit no burner. | Fixed |
| F-2 | High | Holds failed open: a deposit nobody reported counted as spendable. **Fixed**: a deposit watcher (`syncWalletDeposits`) reads every transaction that touched the wallet (Sui GraphQL, oldest first, cursor and net USDC in `wallet_deposit_sync`) and records each arrival, screened and held or cleared. Before a payment, `walletFundsWithheld` runs it and withholds held + blocked USDC plus any balance beyond the net the watcher has seen; if the watcher cannot read the chain, no payment is built (`holds_unreadable`). | Fixed |
| F-3 | High | Rotation moved held funds to an address with no holds, and the owners' second approval was built over held funds. **Fixed**: holds count by business, not address; the rotation transfer (sender = an earlier wallet of the business) is refused as a deposit (`own_wallet_transfer`) and only counted in the watcher's net; `openSecondApproval` runs the same hold check (`fundsOnHold`) as wallet and open-intent payments. | Fixed |
| F-4 | High | Sandbox webhooks verified with a public fallback secret on any non-production deployment, and the order reference was the intent id's hash. **Fixed**: no fallback; a sandbox webhook needs `FUNDING_SANDBOX_WEBHOOKS_ENABLED=true` and a random `FUNDING_SANDBOX_WEBHOOK_SECRET` of at least 32 characters; the reference is an HMAC under a per-process key. | Fixed |
| F-5 | Medium | Any deposit, dust or held, made a top-up `arrived`. **Fixed**: `arrived` only when cleared USDC for the top-up covers its quote's floor; otherwise `arriving`. A wallet top-up that named a source accepts only that source's money (`not_from_named_source`). | Fixed |
| F-6 | Medium | Partner deliveries were not tied to the partner's address or the order amount. **Fixed**: a provider-channel deposit needs the transaction sender to be one of `FUNDING_PROVIDER_<ID>_SUI_SENDERS` (none configured, none accepted: `not_partner_delivery`); a webhook re-reads an earlier row only when it is held, was first read as a plain transfer or this partner's delivery, and covers the order. | Fixed |
| F-7 | Medium | Bank fingerprints were unsalted SHA-256 of low-entropy data. **Fixed**: HMAC-SHA256 under `FUNDING_SOURCE_FINGERPRINT_KEY` (previous keys still matched); without a key no bank account is added. Partners report the paying account itself; Splash keys it on receipt and keeps neither number nor body. | Fixed |
| F-8 | Low | Circle's event was matched by the emitting package, which on testnet is TokenMessengerMinter, so real mints were missed. **Fixed**: matched by the event type's original package and `receive_message::MessageReceived`, read from testnet. | Fixed |
| F-9 | Low | The accepted quote was optional, USDT variants skipped the peg guard, slippage was not part of the idempotent request. **Fixed** (`accepted_quote_required`; any symbol naming USDT is guarded; slippage and the accepted floor are in the fingerprint). | Fixed |
| F-10 | Low | Source changes left no trail; revocation was permanent. **Fixed**: append-only `funding_source_events` (trigger refuses UPDATE/DELETE); a revoked source can be added again as a new pending row. | Fixed |
| — | Missing | With Elliptic and Chainalysis both set, Chainalysis's CLEAR was taken as the verdict. **Fixed**: Elliptic decides; a sanctions listing still blocks. | Fixed |

A CCTP relayer (the transaction sender of a pure mint) is recorded but not
screened against the minted part: `destinationCaller` is zero, so anyone can
relay a business's mint, and blocking the business's own money for the
relayer's listing would let any sanctioned address freeze it. What the
relayer adds is the remainder, screened as theirs.

## v2 Phase 2 §4.1 — the Business Splash Wallet backend — 2026-10-25

Design: `docs/v2/phase2-business-wallet.md`.

- **Signers sign exactly what they see (review B10).** A signature request
  stores the exact transaction bytes and their digest. What a signer is shown
  (payee, amount, asset, fee bound, quote deadline, new wallet members) is
  decoded from those bytes on the server (`lib/wallet/wallet-tx-describe.ts`),
  never from client state, and the same decoder runs on a signer's device.
  A partial signature is accepted only if it verifies over the stored bytes
  under that signer's own key, with the digest the signer reviewed. Tampered
  bytes, a borrowed key and a replayed signature all fail there.
- **The reader is also a refusal.** A wallet transaction may contain only the
  v2 core wallet and payment calls and the plain USDC balance calls. Every
  `0x2::address_alias` call, any other package, gas-coin use, a withdrawal
  from the sponsor's or an allowance's balance, and any object other than the
  org's own account and the configured config objects are refused before
  anything is stored or signed.
- **An existing intent is paid only as read from the chain.** Its bytes name
  just an object id, so the reader refuses it unless the server read the
  intent first and bound its payee, principal, rate, expiry and asset into
  the request; the withdrawal must be exactly principal plus max_fee, and
  every signer is shown the payee and amount.
- **The signer's device decodes the bytes itself** (`lib/wallet/review-on-device.ts`)
  and checks their digest and hash; the transaction code compared with
  WhatsApp is 16 hex characters (64 bits).
- **Partial signatures** live in Postgres only while a request collects or is
  being submitted, and are cleared in the statement that closes it (executed,
  failed, expired, cancelled) or marks its outcome unknown. Requests last at
  most 24 hours and never past a payment's quote. Nothing logs a signature.
- **No answer is not a failure.** A submission the network did not confirm is
  `unknown`: it keeps its digest and dedupe key until the cron reads the
  digest on chain, or its ValidDuring window passes, so a transaction that
  landed is never recorded as failed and nothing like it is asked for twice.
  A submission stuck past a 5-minute lease is reconciled the same way.
- **No single-key veto.** Only the requester withdraws a request; another
  signer declines, and the request stays open for the rest.
- **The chain is the source of truth** for the founder (the account's
  `owner`), the owners and the current wallet. Every wallet member is made an
  on-chain owner in the founder's nomination. An owner without a passkey
  blocks the wallet until named as excluded; a single-signer wallet with
  co-owners needs each one's consent to that wallet.
- **Mainnet is gated in code** (`lib/server/wallet-network-gate.ts`): no
  wallet request until `WALLET_MAINNET_ENABLED=true` and
  `WALLET_HARDWARE_CHECK_REF` names the hardware check's evidence; production
  will not boot with the first and not the second.
- **Abuse bounds.** Wallet routes are rate-limited per person and per
  business, and the sponsor pays at most 1 SUI of gas per business per 24
  hours on top of the 0.05 SUI per-transaction cap.
- **Simulate before sign.** No request is opened for bytes that do not
  simulate, and the bytes are simulated again before they are submitted.
- **Gas.** Plain transfers go gasless. Move calls are sponsored by the
  operator signer (KMS) from its SUI address balance, with no gas coin in the
  transaction, a 0.05 SUI budget cap, and the sponsor's own check of the
  bytes before it signs. The sponsor pays gas and never pays or receives
  client money (D3). Off unless `WALLET_GAS_SPONSOR=operator`.
- **Tenant isolation.** Every route takes the org from the session
  (`requireSessionAccount`); every store read takes the org; another org's
  request is a 404. The account a wallet transaction names is the org's own
  `sui_business_account_id`, never the single-tenant fallback.
- **Who may ask, who signs off (Sky, 25 Oct).** Staff may ask the owners to
  approve a payment (`wallet_approval_asks`). A payment over the rule cannot
  be opened on chain (`create_intent` refuses it), so it is asked for as a
  draft: its shape is checked, the owners are shown from the policy why it
  came to them, and only the quorum can pay it (`create_for_wallet` +
  `confirm_from_business_wallet_balance`). An ask about an open intent is
  only about one the asker opened (its on-chain maker is their passkey
  address), shown to owners as the chain has it. Asks are accepted or
  declined only by an owner (claimed first, so two owners open one request)
  and withdrawn only by the asker; the owners are messaged when one arrives.
  A staff member's migration of their own USDC needs a
  passkey-signed sign-off from an owner or a person in charge (an off-chain
  role an owner grants and revokes), bound to the member, the source wallet,
  the business wallet, a nonce and a 24-hour expiry; nobody signs off their
  own. A viewer is never in charge. Migration moves USDC only. Every grant,
  revocation, sign-off and ask is in `wallet_authority_events`, append-only
  by trigger; its ids carry no foreign key, so it outlives the users in it,
  and the routes that write it are rate-limited.
- **Offboarding.** Removing a membership (a role change included) revokes a
  person-in-charge appointment and voids every usable sign-off at once.
  A spending rule lives on chain and still pays until the quorum revokes
  it, so the index flags every rule whose holder was removed, is a viewer,
  or is nobody here as `orphaned`, and the owners take them all back in one
  request (`POST /api/wallet/spending-rules/orphaned`).
- **Spending rules (§4.2, `docs/v2/phase2-spending-rules.md`).** A rule is
  an allowance bound to SPLASH_SPEND and named for the business's current
  policy, plus the staff member's place on it. Giving, changing (revoke +
  reissue in one transaction), taking back, recipients and limits are all
  signed by the wallet's quorum; a second approval by one owner who is
  neither maker nor payer. The reader refuses an allowance for any other
  app, `allowance::new`, `rotate_spender`, a dangling proposal, a name for
  another policy, and any policy, allowance or cap the server did not read
  as this business's. The WALLET tag only for an address with a live
  ownership proof of this business; withdrawing the proof cancels a waiting
  request that would tag it. The index rolls each window over as the
  chain will, so what is shown as left is what the next charge sees. A
  change or a reissue keeps what was spent: the lifetime cap less
  `current_spend`, and a window with spending in it honoured until it
  renews. After a rotation the rules are stale until reissued under the new
  wallet, once per wallet generation and only for current members.
- **Gas sponsor (Sky, 25 Oct).** The KMS operator key is the wallet gas
  sponsor; the cap of 1 SUI per business per 24 hours stands.
- **Open:** the hardware 2-of-3 passkey check (one approver, Sky, with three
  of his own authenticators on testnet), the address-alias watcher, zkLogin
  members, a testnet dry run of a sponsored transaction paying gas from an
  address balance, routes for new payments (they need the audit bundle and
  quote the Transfer flow composes), and the Phase 3 signing screen rendering
  the device's own decoding.

## v2 Phase 1 — business wallets, spending rules, a delayed upgrade — 2026-10-24

Brief: `SPLASH_SUI_V2_PROMPT.md` §3. Design and its two reviews:
`docs/v2/phase1-move-design.md`. Mainnet gate: `docs/mainnet-checks-2026-10.md`.

### The money paths, after v2

Exactly two paths move a business's funds to a third party.

| Path | Function | Who authorises |
|---|---|---|
| The owners' multisig | `payment_intent::confirm_from_business_wallet`, `_balance`, `confirm_cross_chain_from_business_wallet` | The protocol: the business wallet signed the transaction |
| Spending rules | `splash_spend::pay_intent` (Sui intents only) | An app-bound allowance from the business wallet, plus its `SpendPolicy` |

The unbound path (`create_payment_intent`, `create`, `confirm_payment_intent`)
is **not in v2 core**. It let any signer, in practice Splash's operator, pay a
recipient from its own coin, and an additive upgrade policy could never remove
it again.

**The legacy approval path is not in v2 core either** (Sky, decision 3, 24
Oct 2026). An earlier revision kept `confirm_with_approval` behind a one-way
`legacy_enabled` switch. A public function, however firmly closed, can never
be removed once published, so `create_payment_intent_for_account`,
`approve_payout`, `confirm_with_approval`, the approver set and the switch are
not published at all (`tests/legacy-path-removed.test.mjs`).

Both paths pay Splash's fee as their own leg (Amendment A1, below and
[`docs/v2/fees.md`](docs/v2/fees.md)).

### What v2 enforces on chain

- **Wallet registration.** Only the founder nominates a wallet. The wallet
  registers itself: the transaction sender must equal the multisig address
  recomputed in Move from its members, and every member must be an owner.
  If one member can meet the threshold alone, the founder must have chosen
  that and the wallet must acknowledge it (D1).
- **Membership after registration.** The business wallet adds and removes
  owners and names the recovery party. It may do so under an owner freeze,
  never under a compliance freeze, and it may remove the founder once the
  founder no longer signs. There is no per-person approver set in v2 core.
  Any one owner can still freeze.
- **Recovery only adds an owner.** If the founder loses their key before
  `nominate_wallet`, no wallet can ever be registered for that account:
  nomination is founder-only and the founder anchor never moves. The business
  applies again (`submit_application`, then KYB). If a wallet's quorum is
  lost, nobody can rotate it, and an owner freeze it does not lift stays; the
  business opens a new account. Its funds stay in its own wallet.
- **Bank-payout floor.** A bank payout must be at least the larger of 99 USDC
  and `ComplianceConfig.min_settlement_amount`, checked when the intent opens
  and again when it settles (abort 434). Other kinds have no floor.
- **Wallet rotation** takes two steps: the current wallet proposes, and the new
  wallet confirms. `wallet_epoch` goes up, so spending rules made under the old
  wallet stop paying, even after a rotation back to the same address.
- **`splash_spend` is immutable.** Nothing in it can rotate a spender or let a
  permit or a `Balance` escape (`npm run check:spend`, in CI).
- **Every `SpendPolicy` mutation is signed by the business wallet.** The policy
  lives outside core, so no core upgrade can reach it. A policy grows (a
  spender, a recipient, a beneficiary, a higher limit, a shorter running
  window, a new spending rule) only while it is the account's current one and
  the account is not frozen. Cutting back is always open.
- **The second-approval threshold counts a running total** (decision 4). A
  payment needs an owner's approval when it, with what its payer has already
  paid that recipient in the current window (24 hours by default, fixed at
  the first payment) and what the window before still counts, is above the
  threshold. The total belongs to the payer's address, so removing and
  re-adding a spender does not reset it.
- **Partner deposit addresses are paid only as bank payouts** (decision 2).
  A policy binds each verified beneficiary to one partner deposit address,
  keeps that address off its recipient list (1067, 1068), and pays it only as
  a bank payout for a beneficiary bound to it, so the partner can match
  sender, amount and intent.
- **Spending rules pay on Sui only.** A cross-chain payment is the owners'
  multisig alone (`confirm_cross_chain_from_business_wallet`). No spending
  rule can open, approve or pay one.
- **Splash's KMS operator is an EXECUTOR.** It cannot open an intent, and it
  pays only with an approval naming it: an owner's `approve_payout` naming
  it, or the wallet's `delegate_execution` of an intent the wallet itself
  opened. Staff cannot hand a payment to it. Each approval names the quote's
  deadline (`settle_by_ms`) and `max_total`, the principal plus the Splash fee
  the approver was shown, and dies when the policy removes anything.
- **One `ComplianceConfig`**, created by consuming a ticket minted once at
  publish. A PTB cannot pick a laxer config, and each spending policy pins its
  config's ID (`E_WRONG_CONFIG`, 1028).
- **Registry additions** (assets, settlement apps, bridge adapters) need
  `AdminCap` and on-chain proof that the sender is a quorum multisig. Each one
  gives 24 hours' notice, with every owner alerted, and lapses after 7 days.
  Removals are immediate. The last asset cannot be removed. "Never by a single
  key" means what the chain can prove: the sender holds `AdminCap` and is a
  multisig that no single member can sign for. It does not prove that this is
  the governance multisig, so the mainnet ceremony checks the registries
  before the first business onboards (`docs/MAINNET-CHECKLIST.md`). Every
  accepted asset is assumed to have 6 decimals; nothing on chain checks it,
  so governance verifies it before proposing an asset.
- **The upgrade delay.** `splash_core` upgrades additive-only through
  `splash_upgrade_delay`, which holds the `UpgradeCap`. An upgrade gives 24
  hours' notice, must be authorised within 7 days of it, and the wrapper itself
  is immutable.
- **Idempotency.** A v2 intent's UID is derived from the business's own
  payment reference, so a second intent for the same reference can never exist.
- **Bridge obligations name their coin.** A cross-chain settlement cannot keep
  the business's coin and burn another.

### Splash's fee, on chain (Amendment A1, 24 Oct 2026)

The rules are in [`docs/v2/fees.md`](docs/v2/fees.md). What the chain
enforces:

- **No intent carries a fee.** The fee is computed at settlement by
  `fee_config::splash_fee` from the kind the chain derives and the principal.
  No PTB argument sets a rate.
- **The kind is derived.** `address_registry::derive_kind` charges a
  registered business wallet as a Splash business (free) and a partner
  deposit address as a bank payout. Every settle path refuses a derived kind
  that does not fit the declared one (1400), except a declared wallet or
  exchange payment to a business wallet, so a partner address can never be
  paid as a cheap wallet transfer that skips the bank floor and the
  beneficiary.
- **The ceiling is 100 bps.** No schedule rate or discount may exceed it, and
  every fee is clamped to 1% of the principal. `splash_spend` checks the same
  ceiling with its own constant on `max_fee` before (1037) and on the fee
  core charged after (1032), so no core upgrade can make a spending rule pay
  Splash more. `check:fees` holds the three constants equal.
- **The payer bounds the fee.** Every money path takes `max_fee`, the fee the
  payer was shown, and aborts above it (435; 1031 under a rule). An
  approval's `max_total` bounds principal plus fee (1033). A raised schedule
  can stop a payment, never make it pay more than it showed.
- **The fee leg is inside Move.** It is split in core's settle path and sent
  to `FeeConfig`'s fee recipient, never to an address in the PTB. Every
  remainder (an overpayment, the unused part of `max_fee`) goes to the
  business wallet, never to the sender. This replaces the original H-03 fix,
  which refunded an overpayment to the caller.
- **Fees are off until governance turns them on.** `FeeConfig` is published
  with no fee recipient, and while it has none every fee is 0. The recipient
  is proposed as a multisig's members, weights and threshold, and the address
  is derived on chain; a multisig any one member can sign for is refused
  (1304), so it can never be the KMS operator.
- **Changes give 24 hours' notice and lapse after seven days.** Schedule and
  recipient changes need `FeeAdminCap`, held by the governance multisig. The
  only immediate change is a business's discount, at most 100 bps, which only
  lowers what it pays.
- **`OpsCap` only classifies.** It adds and removes partner deposit addresses
  in Splash's registry, at once and with an event. The registry holds no
  address any payment is sent to, so a stolen `OpsCap` can make a declared
  bank payout to a removed address abort, or a wallet payment to an added one
  abort. It cannot redirect funds or raise a fee.
- **Each `SpendPolicy` pins Splash's `FeeConfig` and `Registry`** (1035,
  1036), as it pins its `ComplianceConfig`.

### What a freeze does and does not do

A freeze, whether by an owner or by compliance, stops every Splash path:
intents, the wallet path and staff allowances. **It does not
and cannot freeze the business's own wallet.** The business holds its keys
(D1) and can always move its own funds directly. Copy, evidence exports and
partner material must never describe a freeze as a funds freeze.

Once a wallet is registered, only the wallet lifts an owner freeze, and in the
same transaction it can remove the owner who pulled it or add a replacement
owner. Only `AdminCap` lifts a compliance freeze.

### Accepted limits, stated plainly

- **Address aliases.** `address_aliases` is on mainnet, and Move cannot see
  whether a multisig has aliased itself to a single key. A wallet whose quorum
  signs `0x2::address_alias` hands that key the wallet. The wallet transaction
  builder refuses alias commands, and a watcher alerts if an alias object
  appears for a wallet, the governance multisig or the operator (Phase 2).
- **What an additive core upgrade can still do.** It could add a function that
  writes an intent's fields, and so make a spender pay a verified recipient
  twice, within caps. It can also change what core keeps: the tier ceilings,
  the KYB flag and the freeze flags. It cannot change a spending rule
  (spenders, recipients, beneficiaries, the policy's limits), point a policy
  at another config, or create an allowance. This is why every proposal
  alerts every owner 24 hours ahead. The alert gives the bytecode digest, the
  upgrade policy and the eta; nothing rebuilds the source to show what
  changes. An added `fee_config` function could rewrite the real
  `FeeConfig`, its fee recipient for example; a rule payment is still bounded
  by `splash_spend`'s own 1% ceiling, and an owners' payment by its
  `max_fee`.
- **Fee proposals reach no owner yet.** The governance alert cron reads the
  upgrade wrapper and the `ComplianceConfig`, not `FeeConfig`. Owner alerts
  for `FeeScheduleProposed`, `FeeRecipientProposed`, their application and
  their withdrawal are Phase 2; until then a fee change's 24-hour notice is
  public on chain only.
- **The fee is outside the principal's limits.** Tier ceilings and a
  policy's limits and threshold count the principal; Splash's fee, at most
  1%, comes on top. The allowance's caps count principal plus `max_fee`.
- **Owners choose a recipient's tag.** An owner can tag an exchange's address
  as a wallet and pay 2 bps instead of 5 to 15 (accepted in A1). Phase 2 KYT
  attribution is to flag it.
- **Fixed windows.** Allowance rate limits are fixed windows, so a limit can
  move twice its size across a window boundary.
- **Split payments.** The threshold now applies to a running total per payer
  and recipient (above), so one spender splitting one invoice needs an
  approval for the part over it. What remains: a split across several
  spenders, each under the threshold, which Phase 2's near-threshold alert
  (read from `RuleSpend`) is to flag; and, with a fixed window, the
  allowance's own rate limit can still move twice its size across a window
  boundary. The allowance's own caps and the account's tier ceilings still
  bound what moves.
- **Bank payouts.** The chain proves the funds reached the partner deposit
  address bound to a verified beneficiary. The partner then pays the bank
  account in the instruction; Phase 2 recomputes the beneficiary commitment
  from that instruction and refuses to send it if they differ. A partner
  address receives nothing under a rule but bank payouts for its bound
  beneficiaries. Several beneficiaries bound to one partner address keep
  separate totals, so the Phase 2 partner payout-instruction API (keyed by
  the intent id) must build each instruction strictly from the intent's
  `beneficiary_ref`.
- **Partner deposit model.** Decided by Sky (decision 2): fixed per business
  per partner, verified once by a test deposit, bound by the wallet. Which
  networks each partner deposits on is still a per-partner question
  (`docs/mainnet-checks-2026-10.md`).

### Decided by Sky (24 Oct 2026)

- **The audit-anchor fee address.** It was open here: the stablecoin lane's
  optional fee leg paid `SPLASH_FEE_ADDRESS_MAINNET`, a single address from
  the environment, and review item B1 rates any Splash-owned receiving
  address in a payout transaction as Critical. Amendment A1 decides it. On
  the v2 settle paths the fee is computed and split inside Move to
  `FeeConfig`'s fee recipient, a proven multisig changed only after 24
  hours' notice. The Send USDC desk, a plain wallet transfer, charges the
  WALLET schedule's fee only when `STABLECOIN_ANCHOR_FEE=on` (off by default)
  and pays that same recipient, read from the mainnet `FeeConfig`; nothing is
  charged while `FeeConfig` has none. `SPLASH_FEE_ADDRESS_MAINNET` is
  retired. On that desk the fee leg is built by the server from the
  `FeeConfig` it read, not split in Move.
- **No penalty or late fees.** Splash is not a party to the supplier's
  invoice, so none exists.

## WS4 — operator custody, the code half — 2026-10-23

**Scope**: the hot operator signer — how it is held, how much it may hold, and
who watches what leaves it. Code: `lib/server/operator-signer.ts`,
`lib/server/operator-balance.ts`, `lib/server/operator-outflows.ts` (pure) and
`operator-outflow-monitor.ts`, `app/api/cron/operator-outflows`, `lib/env.ts`.
Runbook: `docs/OPERATOR-KEY-ROTATION.md`. Tests:
`tests/operator-custody.test.mjs` (16), plus updated expectations in
`tests/env.test.mjs` and `tests/launch-scope.test.mjs`; nothing in them reaches
AWS or a fullnode.

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| OC-1 | High | The operator key was a raw `suiprivkey` in the host environment, decoded into the Node process on first use. Anyone who could read the environment or the process memory — a dependency, a leaked backup of `.env.local`, a debug endpoint — had the key for good, and rebuilding the host did not revoke it. **Fixed**: `getOperatorSigner()` returns an `AwsKmsSigner` (`@mysten/aws-kms-signer`, `AwsKmsSigner.fromKeyId`) when `OPERATOR_KMS_KEY_ID` is set; the key is generated in KMS and never leaves it. A compromised host can request signatures while it is compromised — see OC-3 — but cannot take the key away, and disabling the KMS key stops it at once. | Fixed (code); key and IAM role pending |
| OC-2 | High | Nothing stopped production from running on the raw key after a KMS key existed. **Fixed**: `NODE_ENV=production` refuses to boot while `OPERATOR_SUI_PRIVATE_KEY` or `SUI_SPONSOR_PRIVATE_KEY` is set, even next to a KMS key and even in simulate mode (a key in the environment is a key in the process, used or not); `getOperatorSigner()` refuses it at runtime too; and production no longer falls back to the Sui CLI keystore, which is a raw key in a file. Where the operator signs, production requires `OPERATOR_KMS_KEY_ID`, `AWS_REGION`, `OPERATOR_SUI_ADDRESS` (checked against the KMS public key) and `OPERATOR_HOT_BALANCE_CEILING_MICRO`. | Fixed |
| OC-3 | Medium | The operator address could hold any amount, and a payout larger than its balance failed only on chain, with an opaque abort. **Fixed**: `assertOperatorCanPay(amount)` runs before the operator-funded paths (`recordSingleTransferOnSui`, `confirmComposedPaymentOnSui`) build and sign. Below the payout it throws `OperatorTopUpNeededError` (`state: 'top-up-needed'`) and pays nothing — never a partial payment. Above `OPERATOR_HOT_BALANCE_CEILING_MICRO` (micro-USDC) it alerts with the excess to sweep to cold, and does not block the payout. bigint throughout. | Fixed |
| OC-4 | High | No one would have noticed value leaving the operator address by any route other than Splash's own. **Fixed**: `/api/cron/operator-outflows` (bearer `CRON_SECRET`, every 15 minutes) reads what the address sent over Sui GraphQL and alerts on any outflow that is not `payment_intent::confirm_with_approval` in our core package, to a wallet beneficiary whose screening is CLEAR or ATTESTED. Gas is not an outflow. Value into an object rather than an address is flagged. A monitor that cannot read its inputs answers 502 rather than reporting all clear. | Fixed |
| OC-5 | Info | Canon D-0004: the operator key must never enter 0xWal's process or any agent tool. **Enforced**: a test fails the build if anything under `lib/agent`, `lib/oxwal`, `lib/ai`, `lib/chain` or the agent and copilot routes imports the signer or settlement module, or names an operator key or AWS secret. The outflow monitor itself never builds a signer. | Guarded |

**Revised for v2 (Amendment A1 review, 24 Oct 2026).** OC-4's approved path
above is v1's: v2 core has no `confirm_with_approval`. The monitor's rule is
now (`lib/server/operator-outflows.ts`): the operator is an EXECUTOR and pays
only through `splash_spend::pay_intent` in our `splash_spend` package, with
`audit_anchor::anchor` in our core package in the same transaction, from the
business wallet's allowance and never from its own balance. On that path
every address that gained value must be an approved wallet beneficiary, an
address Splash's registry classifies (a partner deposit address or a business
wallet), or `FeeConfig`'s fee recipient. Anything else is flagged:
`not_approved_path` (value moved off that path, including the retired
`confirm_with_approval`), `operator_paid_from_own_balance`,
`recipient_not_approved`, or `outflow_without_recipient`. The monitor reads
`SPLASH_SPEND_PACKAGE_ID`, `SPLASH_FEE_CONFIG_ID` and
`SPLASH_ADDRESS_REGISTRY_ID` (`lib/server/operator-outflow-monitor.ts`). A
read that fails fails the run rather than reporting all clear; with an id
unset, payments that need it are flagged, not cleared. The bullets below are
kept as written for v1.

**Still open, and stated.**

- **The monitor is deliberately stricter than main.** The gas-funded
  `settle_payment` path and the composed `confirm_payment_intent` path both
  pay out of the operator address without the approver, and the monitor
  flags both. That is the intended pressure: those paths should move onto
  `confirm_with_approval` (WS3's service orders do). Until they do, a flagged
  digest from one of them is expected noise and is checked against Splash's
  own settlement records before it is treated as a compromise. Batch payouts
  are paid from the treasury object, not the operator, so they carry no
  hot-balance check; the monitor still sees them, because the operator signs.
- **The hot-balance check is a pre-flight, not a lock.** Two payouts racing
  for the last coins can both pass it; the chain then rejects the one it
  cannot fund, and that one pays nothing.
- **The ceiling is measured in USDC.** On main the operator-funded payouts are
  in SUI; for those the check refuses below the payout in MIST and alerts on
  the USDC balance. With the development stand-in (`USDC_TYPE=0x2::sui::SUI`)
  the ceiling is skipped rather than compared across decimals.
- **The GraphQL query shape** follows the one `lib/server/wallet-activity.ts`
  already runs in production, with `relation: SENT`, Move-call commands and
  gas effects added. It was not run against a live indexer from the machine
  this was written on (no outbound TLS); the first scheduled run answers 502
  with the indexer's message if the schema disagrees.
- **Static AWS keys.** The DigitalOcean Droplet cannot assume an EC2 role.
  `OPERATOR_KMS_CREDENTIALS=static` exists for it; the IAM user must be scoped
  to `kms:Sign` and `kms:GetPublicKey` on this one key. IAM Roles Anywhere is
  the better answer and is supported through temporary credentials in the
  environment.
- **On-chain rotation arrives with WS3.** `settlement_policy::set_operator`
  from the cold multisig is documented in the runbook and is not on `main`.
- **People and hardware.** The KMS key itself, the IAM role or scoped user,
  the alert receiver and the cold multisig signers are not code and do not
  exist yet. Until they do, production cannot boot with the operator signing,
  which is the intended state.

---

## WS8 — every store in Postgres — 2026-10-23

**Scope**: the stores that still kept their records in a `Map` on
`globalThis`. On serverless each instance has its own copy, so state differs
between instances and a cold start drops it: a deposit webhook answered by
another instance found no funding session, a staff console found no ticket a
customer had just raised, and a reconciliation summed only one instance's
legs. Every one of them now reads and writes Postgres; the in-process map is
kept only as the fallback when `DATABASE_URL` is unset (`npm run dev` without
a database), and each store warns once when it falls back. Tests drive a
migrated PGlite behind the app's own `getDb()` and simulate a cold start by
dropping every `globalThis` store and evaluating the module again
(`tests/helpers/store-db.mjs`), all in `npm run test:db`.

| Slice | Tables (migration) | What the database now enforces | Tests |
|---|---|---|---|
| Recipients, invoices, transfers + receipts, ledger | already on main | pinned: survive a cold start; a race on one idempotency key or pay-link slug leaves one row | `operational-store-durability` (6) |
| Sweep jobs, rate holds | `sweep_jobs`, `rate_holds` (0027) | one sweep per transfer (a second is a second payout); a hold must have an owner | `sweep-rate-hold-persistence` (5) |
| Funding sessions | `funding_sessions`, `funding_source_transactions`, `funding_last_used_sources` (0028) | one deposit, one session (digest is the key); credit and CREDITED in one locked transaction; last-used source per org | `funding-session-persistence` (5) |
| Intercompany legs | `intercompany_transfers` (0029) | one leg per customer transfer; the daily reconciliation sums every instance's rows | `intercompany-persistence` (3) |
| Support tickets | `support_tickets`, `support_ticket_replies` (0030) | `org_id NOT NULL` + FK on both; WS2's org scope is in the WHERE clause, so a foreign id reads as missing and a foreign reply or close writes nothing; replies are inserts, so two at once both land | `support-persistence` (4) |
| Daily audit batches | `daily_audit_batches` (0031) | one batch per business date (unique index); the cron's "already built?" check sees every instance's batches | `audit-batch-persistence` (3) |

**Support tickets and daily audit batches are no longer in memory.** They
were the last two `globalThis` stores holding records, and the ones WS2 had
just scoped. Support keeps WS2's shape exactly — customer functions take the
session's org first, staff reach across tenants only through `*ForStaff` —
and the demo seed tickets stay in the fallback, because the demo org does
not exist in a real database. The audit-batch table has **no `org_id`**, on
purpose and said so in the schema and migration: a batch spans every tenant
(its leaves are many workspaces' transfer ids), so there is no owner to scope
by, and the protection remains who may read it (staff-only readers behind
`getAdminSession()`).

Every function in both stores is async now, and every caller awaits it. Two
of those callers handed the result straight to `NextResponse.json`
(`/api/admin/support`, `/api/audit-batches`), where a Promise serialises as
`{}` and `tsc` does not object; both await explicitly, with a comment.

**Operators must apply migrations `0030_support_tickets` and
`0031_daily_audit_batches`** (with 0027–0029 if not yet applied) before this
release serves traffic: `npm run db:migrate:run`, or the pre-deploy job in
`docs/DEPLOY-DIGITALOCEAN.md`. No backfill: the in-memory tickets and batches
never outlived an instance, so there is nothing to carry over.

**What it does not do.** Two cron runs for the same business date that both
start before either records still both seal, store and anchor; the database
keeps the first batch and both runs return it, so the day has one recorded
root, but the later run's Walrus blob and Sui anchor are left unreferenced.
Closing that would mean holding a lock across up to a minute of Seal, Walrus
and Sui calls, for a job that runs once a day. Demo-mode Walrus blobs are
still process state, so verifying a demo batch after a cold start reports the
blob missing; live Walrus is unaffected.

---

## WS2 — the four remaining unscoped stores — 2026-10-23

**Scope**: the stores that still answered any signed-in session with every
tenant's data, and the routes in front of them. The pattern is the one the
transfer, invoice, beneficiary and ledger stores already follow: `orgId` is
the first, required parameter of every customer read and write, so an
unscoped call site does not compile; the org comes from the session
(`requireCustomerRequest`, then `requireSessionAccount`, which resolves it
through `resolveAuthorityForSession`), never from the request; reach across
tenants is spelled `*ForStaff` and sits behind `getAdminSession()`. The
master prompt calls the member guard `requireMember`; it does not exist on
main, and these two existing helpers are what it means. Tests:
`tests/tenant-isolation.test.mjs` (11; red commit `8b278d5`, fix `0124707`),
in `npm run test:db`.

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| WS2-1 | Low (pinned) | MemWal (Copilot memory). Already scoped on main: `recallForOrg` / `rememberForOrg` in `lib/server/memwal.ts` are the only entry points, every write goes to the org's own namespace with the org's key at the start of the text, and recall drops anything without that key (`lib/server/memwal-scope.ts`). Every caller passes the session's org or, in the demo seed, `DEMO_ORG_ID`. **Pinned**: recall for org B returns none of org A's fact even from a relayer that ignores namespaces; the adapter exports nothing unscoped; nothing but `memwal.ts` imports the SDK. | No change needed |
| WS2-2 | High | Support tickets. `listSupportTickets()` and `readSupportTicket(id)` took no org, so any customer could list every tenant's tickets (subjects, messages, contact addresses, staff replies) or read and reply to one by id. The reply's author was a name the request body supplied. **Fixed**: tickets carry `orgId`; `create/list/read/updateSupportTicket(orgId, …)`; a foreign id reads as missing, for a reply too; the staff console and admin routes use `listSupportTicketsForStaff`, `readSupportTicketForStaff`, `updateSupportTicketForStaff`; a customer reply is attributed to `session.email`. | Fixed |
| WS2-3 | High | `GET /api/walrus/:blobId` returned any blob's metadata to any session, and blob ids are not secret: they appear on invoices, receipts and evidence records. **Fixed**: `orgReferencesBlob(orgId, blobId)` (`lib/server/walrus-access.ts`) answers true only when the caller's org owns an invoice, or a transfer whose receipt references the blob (the transfer's own blob, or the evidence bundle in `settlement_metadata.evidence`). Scoped queries in both repositories, reached through their stores. The check runs before the blob is fetched, so another tenant's blob and a missing one are the same 404, and every answer is `private, no-store`. | Fixed |
| WS2-4 | High | Daily audit batches. `GET /api/audit-batches` and `POST /api/audit-batches/verify` took any customer session and returned every batch: each one lists every tenant's settled transfer ids with their Merkle proofs, and the customer history page displayed them. **Decision (Sky)**: staff-only, roots and contents. **Fixed**: the readers are `listDailyAuditBatchesForStaff`, `readDailyAuditBatchForStaff`, `verifyDailyAuditBatchForStaff`; both routes require `getAdminSession()`; the panel is removed from `/dashboard/history`. | Fixed |

### The routes re-checked, and why each is safe

- **`/api/copilot/chat`** no longer exists; it was deleted with
  `lib/copilot-client.ts` (see `docs/HANDOVER-2026-09-06.md`). The copilot
  routes that remain, `copilot/extract-invoice`, `copilot/suggest` and
  `copilot/summary`, each run `requireCustomerRequest` and then
  `requireSessionAccount`, and read only through scoped stores:
  `readInvoice(orgId, id)`, `listInvoicesFor(orgId)`,
  `getCopilotSuggestions(orgId)`, and MemWal through `recallForOrg` and
  `rememberForOrg`. **Scoped.**
- **`/api/profile`** is **per-user by design**. GET, POST and DELETE read
  and write the customer-profile store keyed by `session.email`, and the
  request cannot name another address. The org is resolved only to decide
  whether a WhatsApp approval is required. The staff side
  (`/api/admin/profile-requests`) is behind `getAdminSession()`.
- **`/api/quotes`** is **stateless**: `calculateQuote` prices an amount from
  the corridor table and a cached market rate, and reads no tenant store.
  `recipientId` is echoed back, not looked up. **`/api/quotes/peg-status`**
  is public market data from DeepBook, with no tenant data in it.
- **`/api/oxwal`** takes `orgId` and `actorId` from
  `resolveAuthorityForSession`. The body is only `{ message, history }`, and
  `assertCleanBody` refuses provenance fields, so the agent runs in the
  session's org and nowhere else. **Scoped.**
- **`/api/proposals/[id]/submit`** resolves the session's authority and
  answers 404 when `proposal.orgId !== ctx.orgId`.
  **`/api/proposals/[id]/reconcile`** passes `ctx.orgId` to
  `reconcileStuckPayment`, which answers 404 on the same mismatch
  (`lib/server/stuck-payments.ts`). **Scoped.**

**Still open.** ~~Support tickets and audit batches still live in an
in-process `Map`, so they are per-instance and disappear on restart; they are
scoped now, but not durable.~~ Closed by WS8 (above): both are in Postgres,
migrations 0030 and 0031. A signed-in person with no membership yet gets
`no_membership` (403) from the support routes and has to use the support
address instead. The staff console has no audit-batch page, so the
staff-only API currently has no UI. `components/oxwal/ActionCard.tsx` links
to `/api/walrus/<reasoningTraceRef>`, but those refs (`pending-walrus:…`,
`dual-approval:…`) are not blob ids, so the link 404s, as it already did.
~~`listAllRequests` and `decideProfileRequest` in
`lib/server/customer-profile.ts` are staff-only in practice but not named
`*ForStaff`.~~ Renamed `listProfileRequestsForStaff` and
`decideProfileRequestForStaff` in the WS2 follow-up (5ba1ba2).

---

## Approvals by code and WhatsApp — 2026-09-24

**Scope**: the two ballot channels for payments the money routes send for
approval — a code typed into Splash (`app/api/approvals/code`) and a WhatsApp
reply (`app/api/webhooks/whatsapp`) — and where they meet the in-app submit
route. Tests: `tests/approval-channel-settlement.test.mjs` (PGlite, driving the
real `proposeForApproval`, ballots and settle path; source assertions for the
three routes).

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| AC-1 | Medium | No ballot-approved payment could ever execute. `proposeForApproval` leaves a proposal SIMULATED; `settleFullyApprovedProposal` applied APPROVE (accepted only from PENDING_APPROVAL), swallowed every refusal, then threw on SIGN from SIMULATED, so every approver was told "Approved, but the payment could not be completed." **Fixed**: one walk for every channel (`lib/queue/approval-walk.ts`) — SIMULATED → POLICY_EVALUATED → PENDING_APPROVAL (or APPROVED when policy asks for nobody), then one APPROVE per ballot through the state machine. The submit route now calls the same functions. | Fixed |
| AC-2 | High | Once AC-1 was fixed, the ballot path would have skipped the approval-time re-evaluation the submit route runs: policy, quote expiry, compliance screening, circuit breaker. A reply would have been worth more than a click. **Fixed**: `evaluateAtApproval` runs `authorizeProposalSubmission` before any ballot is counted; a block leaves the proposal where it was. | Fixed |
| AC-3 | High | The webhook replayed the money route with `cookie: ''`. The route reads its session through `cookies()`, which answers from the incoming (Twilio) request, so it refused. The fix that suggests itself — let the replay authenticate as "the approval" — would add a sessionless way into both money routes and make a SIM swap or an unlocked phone enough to move money past maker-checker. **Decision**: a reply is a vote. A unanimous reply walks the proposal to APPROVED and stops; money moves only for a signed-in approver — the one whose code completes the vote, or one who releases it in the app. `releaseApproved` refuses the maker and, once approvals were required, anyone without an approving role (a viewer is read-only). | Fixed (by design) |
| AC-4 | Medium | In `code` mode an APPROVE reply was accepted anyway: the webhook never read the ballot's channel, so the default "handset AND signed-in approver" was one reply from "handset only". **Fixed**: on a `code` ballot a reply can refuse and cannot approve. | Fixed |
| AC-5 | Medium | The code route decided eligibility from the session's role mapped back to a membership name through a table with no FINANCE_ADMIN (a finance admin became `viewer`), and that role is the one in whichever workspace the session resolved to. Settle read each ballot's role from any of the user's memberships. **Fixed**: `resolveApproverById(userId, token.orgId)` reads the membership row in the payment's org; ballot roles are read in the proposal's org; the webhook's ballot lookup is scoped to the org the number was checked in. | Fixed |
| AC-6 | Medium | A ballot REJECT stopped the tally but left the proposal approvable in the app, although the approver was told "no further approvals can change that". **Fixed**: a refusal rejects the proposal, unless the payment was already released, in which case the record is left true and the approver is told so. | Fixed |
| AC-7 | High (latent) | A code-channel release runs the replay as the releasing session, and the money route takes the paying account from the session. An approver signed in to another workspace would have had the approved payload carried out there: the approval claim is refused cross-org, and the route treats the request as a new payment. **Fixed**: release requires the session's org to be the proposal's; otherwise the proposal waits at APPROVED. | Fixed |

**Still open.** Compliance at approval time reads only the agent's counterparty
fixtures (`resolveComplianceForProposal`), so a real money-route beneficiary
blocks with "compliance hold" on every path, in the app and on both ballot
channels. Nothing in the UI posts to `/api/approvals/code`, and the queue
board's Approve/Reject is client-only, so a payment approved over WhatsApp is
released today through `proposals/[id]/submit` (the Zeke card, or a direct
call). Approvals given in the app and ballots are counted separately: an
approver who approved in the app still has an open ballot, and a unanimous
tally waits for it.

---

## The agent's two names — 2026-09-23

The agent's display name is **Zeke**. Its persisted actor id is `OXWAL` and
does not change; two security rules compare against it — the maker-checker
exemption and the signer rejection — and both now read the constant
`AGENT_ACTOR_ID` from `lib/agent/identity.ts` rather than a string literal.
`tests/agent-identity.test.mjs` fails the build if the literal drifts, if a
raw comparison reappears outside the constant, or if the old display name
resurfaces on a user-facing surface.

---

## WS1 — account pre-hijacking (X5) — 2026-09-23

**Scope**: the account lifecycle from signup to grant, on the application
tier. Reproduced first as a test that passed on the tree before the fix
(`tests/account-verification.test.mjs`, red commit `9edda4a`), then closed
as one unit — refusing grants to unverified accounts without delivery would
have blocked every onboarding.

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| X5 | High | Signup never proved the mailbox — `lib/auth/accounts.ts` shipped `markEmailVerified` with no caller and a comment saying delivery was not built — and `grantRole` / `grantMembership` only required that a row exist. An attacker who registered `cfo@victim.example` first received the approver grant the administrator later made to that address; the real CFO's own signup answered 201 and changed nothing. **Fixed**: (1) a delivered, single-use, hashed, 30-minute token (`lib/auth/email-verification.ts`; table `email_verification_tokens`, migration `0006`); (2) a transport production cannot leave unset — `EMAIL_TRANSPORT=resend`; `console` is refused by `lib/env.ts` in production; (3) the mailbox owner wins: opening the link *sets* the password rather than confirming the one on file, so a pre-registered password stops working at that moment; (4) `users.credential_version`, carried in the session cookie and re-read by every `getCustomerSession()`, so every session minted before the verification is refused afterwards; (5) both grant paths refuse `email_verified_at IS NULL` with an operator-facing `unverified_email`, and `grantMembership` no longer inserts a password-less user on the way to granting; (6) zkLogin marks an address proven only when the token carries the boolean claim `email_verified: true`; (7) signup, resend, recovery and both link-consuming routes are rate limited per address and per network in Postgres (`lib/server/rate-limit.ts`, table `rate_limit_hits`); (8) `/forgot-password` is a real reset on the same primitive, with the same three consequences. | Fixed |
| WS1-F1 | Medium | Found while binding sessions to a credential version: the fifteen-minute idle timeout from Phase 4 had never fired. `readCustomerSessionToken` rebuilds the session field by field — correctly, so an unsigned field cannot ride in — and never copied `lastSeenAt`, so every read saw "no stamp", which `evaluateIdle` treats as active. Reproduced red in `174ef22`. **Fixed** in `6a1e5be`: the stamp survives the read; `requireCustomerRequest`, the entry every authenticated route handler uses, re-stamps it at most once a minute through `touchCustomerSessionCookie`, which moves `lastSeenAt` and nothing else — the token keeps its `exp` and the cookie its remaining lifetime — so making the clock real did not turn it into a sliding absolute expiry. Pages stay pure reads. | Fixed |

**What it does not do.** An account can still be *created* for any address,
and the 201 stays uniform so signup is not an enumeration oracle. What
changed is that creating one earns nothing until the mailbox answers, and
keeps nothing once it does.

**Operator notes.** `EMAIL_TRANSPORT`, `EMAIL_API_KEY` and `EMAIL_FROM` are
declared in `lib/env.ts` and `.env.example`. The staff console's grant now
fails with `unverified_email` for an unproven address; the person has to open
their link (or request a new one from `/verify-email`) first.
`scripts/dev-db.mjs` seeds verified accounts, except Lin, who is left
unverified on purpose so the refusal can be seen.

---

## WS5 — Event privacy before the immutable publish — 2026-09-23

`splash_core` publishes immutable, and an event struct's fields freeze with
it. Until this pass six events carried the payment in cleartext:
`IntentCreated` (sender, recipient, amount_usd, target_currency,
fx_rate_usd_local), `IntentConfirmed` (sender, recipient, amount_paid),
`IntentCanceled` (sender), `SettlementAnchored` (sender, recipient,
beneficiary_ref, amount, currency, corridor), `PayoutApproved` and
`PayoutApprovalConsumed` (amount). `ReceiptIssued` carried the same, and the
meta-test found three more of the same class: `ApplicationReceived` (the
company registration number and the KYB pointer), `BusinessVerified` (the
risk score) and `DailyCapChanged` (the ceiling).

**What ships.** Every payment lifecycle event now carries `intent_id`, a
32-byte `commitment`, `status` and `timestamp_ms`, and nothing else; the
anchor event adds the two evidence pointers (a ciphertext hash and a Walrus
blob id). The commitment is `blake2b256(DOMAIN_TAG || bcs(payload) || salt)`
with a documented field order and 32 CSPRNG salt bytes per payment, computed
off-chain by `lib/evidence/commitment.ts` before the intent is opened. Move
asserts the length (`E_BAD_COMMITMENT`, 420 and 804) and carries the bytes.
The salt and the payload live only in the Seal bundle
(`splash.settlement-evidence.v2`); nothing logs or emits the salt, and a
test checks the settlement layer does not have the word in it.
`scripts/verify-commitment.mjs` checks a settlement against its events for
anyone the Seal policy admits. Specification and vectors:
`docs/commitments.md`. Tests: `tests/event-privacy.test.mjs` (8) and
`move/splash_core/tests/event_privacy_tests.move` (7).

**What this does not hide.** The base-layer coin transfer still shows
sender, recipient and amount. This removes Splash's business metadata from
the event stream, not the transfer. Confidential transfers stay quarantined
under the four-gate decision below.

**Found on the way, not resolved here, for Sebastian.**

1. *Objects still hold the cleartext.* `PaymentIntent` (shared) stores
   `recipient`, `beneficiary_ref`, `amount_usd`, `currency`, `corridor`,
   `target_currency` and `fx_rate_usd_local`; `ReceiptV2` (shared) stores
   the counterparties and both amounts; `BusinessAccount` stores the
   registration number, the KYB pointer and the risk score. Anyone who reads
   the object learns what the event no longer says. The amount and the
   recipient must stay on the intent (`settle` splits the coin by them), but
   the beneficiary reference, the corridor, the target currency and the rate
   could be replaced by the same commitment. That changes object layouts,
   which also freeze at publish, so it is the same deadline as this pass.
2. *Per-family, not per-event, domain tags.* The prompt asked for a tag per
   event. Every lifecycle event of one payment carries the same commitment,
   because an intent can be expired by anyone and a stranger holds no salt,
   and because a second hash over a salted value hides nothing more. If he
   prefers a per-event derivation, `blake2b256(EVENT_TAG || commitment)` on
   chain is a small change.
3. *`amount_band`.* Not included. The prompt allows a coarse `amount_band: u8`
   only if Sebastian approves it; adding a field later is trivial before
   publish and impossible after.
4. *The testnet settlement.* `scripts/verify-commitment.mjs` is exercised
   against fixture events in the test suite. Verifying a real settlement
   needs the new `splash_core` published to testnet, which is a publish and
   therefore not done here.

---

## WS6 — Phase-0 custody gates — 2026-09-23

**Scope**: every path that would hold customer funds before the licence
exists. Reproduced first as tests that fail on the tree before the fix
(`tests/phase0-custody-gate.test.mjs`, red commit `ea423b6`).

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| WS6-1 | High | `transfers/authorize` accepted `deliveryTier: STORED_BALANCE` or `SWEEP_ACCOUNT`, and `POST /api/recipients` accepted any `tier` string, with no custody package configured — the product would take a recipient's funds into a stored balance or a sweep account it has no licence to hold, in Phase 0. **Fixed**: `lib/server/custody-phase.ts` decides the phase from the custody package alone; both routes refuse non-`PAYOUT_ONLY` tiers with a plain, licence-named 403 (`custody_not_licensed`) before a recipient or an intent is written. | Fixed |
| WS6-2 | High | `lib/server/treasury.ts` keeps a per-user USDC/USDY ledger in a process-global `Map` (invariant I7), seeds a $11,140 / $24,500 / $98.72 demo ledger for any unknown account, moves the ledger on a *quote* in `moveToTreasury` and `settleWithdrawal`, has a double-settle race (`notice.state = 'SWAPPING'` across an `await`), and does money arithmetic in JS `number`. `/api/treasury` served it as a balance. **Gated off**: `/api/treasury` GET and POST and both crons answer the licence-named 403 until the custody package exists; the ledger is never read in Phase 0. The module itself is unchanged and its defects stand until Phase 2 work replaces it — recorded here so they are not mistaken for fixed. | Gated |
| WS6-3 | Medium | The treasury page rendered six hardcoded "confirmed" transactions and three hardcoded balances from constants before its first fetch, described the contract as "Audited" with no source, and promised that idle balance "earns a floating T-bill rate"; the overview card invented "+$3.22" of daily yield; 0xWal read the seeded demo ledger to pitch allocations. **Fixed**: constants deleted, both surfaces show "Treasury arrives with our licence" in Phase 0 and nothing before the ledger answers, the copy is a labelled projection, and the copilot answers with the phase reason and never quotes a rate or a balance. The illustrative daily-yield chart series on the treasury page remains for Phase 2 and is flagged for WS9's copy pass. | Fixed |

---

## WS7 — rate limits and security headers — 2026-09-23

**Scope**: the browser boundary and every route that spends something.
Reproduced first as ten tests that fail on the tree before the fix
(`tests/rate-limits-and-headers.test.mjs`, red commit `190a742`), then closed
(`8dbdc59`).

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| WS7-1 | High | No Content-Security-Policy anywhere, so any injected inline script ran, and no `frame-ancestors`, so the approval screens could be framed. **Fixed**: `lib/security/csp.ts` builds the policy around a nonce that `proxy.ts` mints per page request from the CSPRNG — `script-src 'self' 'nonce-…' 'strict-dynamic'`, never `'unsafe-inline'` or `'unsafe-eval'` in production; `frame-ancestors 'none'`; `object-src 'none'`; `base-uri` and `form-action 'self'`; the only third party allowed is Sumsub (a frame and its API), for KYB. The policy rides the request (`x-nonce` and the header Next reads to nonce its own scripts) and the response. Because a nonce cannot be prerendered, `app/layout.tsx` renders every page per request — the marketing pages lose static prerendering, deliberately. Styles keep `'unsafe-inline'`: React `style={{}}` props render as inline style attributes across the app, and scripts are the surface that matters. | Fixed |
| WS7-2 | Medium | No HSTS, no `nosniff`, no referrer policy, no frame header. **Fixed**: `next.config.ts` `headers()` sets five on every response, API routes included — `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a `Permissions-Policy` that leaves only the camera and microphone on, for the Sumsub flow. `lib/security/headers.ts` is the single list the config and the test both read. | Fixed |
| WS7-3 | High | The public pay link (marks an invoice paid and creates a recipient), the four `/api/copilot/*` routes (chat spends model credits per message; extraction feeds a document to the model), `/api/seal/access` (a key-server round trip), invoice creation and recipient creation had no limit of any kind. **Fixed**: `enforceRateLimit` in `lib/server/rate-limit.ts` in front of each, per user and/or per network, with the rules named in `RATE_LIMITS`. Without a database on a development machine the limits are skipped once, loudly; production cannot boot without one (`lib/env.ts`). | Fixed |
| WS7-4 | Low | The login limiter was a second implementation on its own `login_attempts` table. **Fixed**: `lib/auth/login-rate-limit.ts` is now a thin layer over the one limiter — failures count, a success clears — with its public API unchanged. `login_attempts` is legacy, no longer written, and waits for a drop migration. | Fixed |

**What it does not do.** The CSP allows inline *styles*; a hash-per-prop policy is not practical here. The rate limits are per address and per network, not per organisation; the tenant key arrives with the tenant-isolation patch. The public pay link still marks an invoice paid on the caller's word alone — that is a WS2/WS8 concern recorded in the report, not a limit problem.

**The client address (fixed 2026-09-26).** Per-address limits key on `clientIp` in `lib/server/rate-limit.ts`, which reads X-Forwarded-For from the end, `TRUSTED_PROXY_HOPS` entries back (default 1, the Droplet's nginx). Before, it trusted the first entry, which the caller writes, so a new header bought a fresh bucket on every request. An address it cannot believe (hops 0, a chain shorter than our proxies, an entry that is not an address) falls into one shared `unknown` bucket. On App Platform, whose `X-Forwarded-For` carries DigitalOcean's ingress address, `CLIENT_IP_HEADER=do-connecting-ip` reads the caller's address instead; on the Droplet it stays blank, because nginx passes a caller's own header through.

---

## Re-audit pass — 2026-07-13

**Scope**: all 9 modules under `move/sources/` at HEAD. Methodology: OtterSec
checklist (capabilities, authority, asset flow, replay, events, upgrade
posture) + OpenZeppelin math standards. `sui move build` passes (CLI 1.59.1).
`sui move test` is blocked by a pre-existing incompatibility between the
pinned deepbook rev's own test files and the CLI stdlib — unrelated to
`splash_protocol` sources; tracked as a toolchain item.

**Verification of prior findings.** The scaffold rewrites HAVE landed in this
tree: C-01/C-02 (smart_treasury holds a real `Balance<T>`), C-03 + H-01/02/03
(payment_intent binds sender via `tx_context`, uses `&Clock`, refunds
overpay), H-05 (peg state initializes broken-until-first-update), M-01/M-02
(audit_anchor AdminCap-gated, real verification), M-03/L-05 (receipt_v2
immutable + gated). The "Open" statuses in the 2026-05-29 table below are
retained as history; module doc-comments name the finding IDs they fix.

**New findings (this pass):**

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| S-01 | Medium | `BusinessAccount` has `store`, so a KYB-verified account object can be transferred/sold; `settle_payment` accepted any holder. **Fixed**: `settle_payment` now asserts `owner == tx_context::sender` (abort 106 `E_NOT_ACCOUNT_OWNER`). Ability itself cannot change in an upgrade — flag for next package version. | Fixed (mitigation) |
| S-02 | Medium | `SettlementPool.protocol_fees` had no extraction path — protocol revenue permanently locked in the shared object. **Fixed**: AdminCap-gated `withdraw_fees` + `FeesWithdrawn` event. | Fixed |
| S-03 | Low | `ComplianceCap` (`key`-only) could never be rotated to a new custodian. **Fixed**: `transfer_cap`. | Fixed |
| S-04 | Low | Shared `PaymentIntent` objects lived forever after finalization (storage growth). **Fixed**: `delete_finalized` (abort 412 `E_STILL_PENDING`). | Fixed |
| S-05 | Low | Raw u128 fee math in `settlement` replaced with OpenZeppelin `u64::mul_div(..., rounding::down())` — checked overflow, rounding documented as payer-favoring. | Fixed |
| S-06 | Info | `AdminCap` has `key, store` — publicly transferable/wrappable. Custody policy must treat it as a bearer asset; ability change requires a new package (upgrade rules forbid ability edits). | Advisory |
| S-07 | Info | `settle_batch` attributes `PaymentExecuted` events to whichever `BusinessAccount` the operator passes; attribution is operator-trusted, not chain-enforced. | Advisory |
| S-08 | Info | `payment_intent::create` mints its `SettleReceipt` at creation time, so `SettlementAnchored` can fire for intents that never confirm. Off-chain indexers must join on `IntentConfirmed` before treating an anchor as a settlement. | Advisory |
| S-09 | Info | `assert_deepbook_liquidity` in the caller-facing `settle_payment` path reads a caller-chosen `Pool<T, QuoteAsset>`; a permissionlessly-created pool with self-provided liquidity satisfies the guard. Acceptable today because the guard only gates the caller's own funds, but do not repurpose it to protect pooled funds. | Advisory |

New abort codes to mirror in `lib/server/sui-settlement.ts::ABORT_CODES`:
`106 E_NOT_ACCOUNT_OWNER`, `412 E_STILL_PENDING`.

---

## Custody & liquidity pass — 2026-08-13

**Scope**: the capability split required by `docs/splash-wallet-onboarding-custody-spec.md`
§10 (cold multisig holds money authority; hot operator key runs the daemons),
plus a live-fire investigation of why batch payouts never settled on testnet.
Methodology: same OtterSec checklist, plus reproduction against the live
testnet SUI/DBUSDC pool `0x1c19362c…`.

**New findings (this pass):**

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| S-10 | Medium | Every routine attestation (`peg_monitor::update_peg`, `audit_anchor::anchor_audit_hash`, `receipt_v2::create_receipt`, `smart_treasury::emit_rebalance`) required `&AdminCap` — the same cap that authorizes withdrawals. Because the peg daemon must sign every ~30s, `AdminCap` could never move to the cold 2-of-3 multisig, so a compromised operator host held full money authority. **Fixed**: new `AnchorCap` (`key` only, no `store` — non-transferable, minted/destroyed by `AdminCap`) gates the four non-financial writes; `AdminCap` keeps withdraw/allocate/redeem/config only. | Fixed |
| S-11 | High | `peg_monitor::assert_deepbook_liquidity` rejected **100% of batches regardless of liquidity**, via two independent bugs: (a) it required `remaining_base == 0`, unsatisfiable on a lot-quantized book whose input-fee quote path also deducts the taker fee from the input — measured remainder was ~0.098 SUI at every size from 1.1 to 5.0; (b) slippage was priced against the *requested* quantity, charging the unfilled dust as if it executed at zero, turning a real 56 bps into a reported 809 bps and tripping `E_SLIPPAGE_EXCEEDED` on a healthy pool. **Fixed**: require `filled/requested >= MIN_FILL_BPS` (9,000) and price the filled base. Arithmetic pinned in `tests/deepbook-liquidity-guard.test.mjs`. | Fixed (needs republish) |
| S-12 | Medium | `settle_batch` calls `assert_deepbook_liquidity` against pooled funds — exactly the repurposing **S-09** warns against. The pool argument is operator-supplied and DeepBook pools are permissionlessly creatable, so a compromised operator could stand up a pool, seed it with their own liquidity, and satisfy the depth and slippage asserts trivially while draining the shared `SettlementPool`. **Fixed**: `ComplianceConfig.allowed_deepbook_pools: VecSet<ID>` (non-empty, capped at `MAX_ALLOWED_POOLS = 8`, mutated only through `allow_pool` / `disallow_pool`, each emitting its own event); `assert_deepbook_liquidity` now calls `assert_pool_allowed(config, object::id(pool))` **before reading a single field off the pool** (abort 353). Off-chain preflight in `lib/server/sui-settlement.ts::assertDeepbookPoolWhitelisted` blocks a mismatched `DEEPBOOK_POOL_ID` before the PTB is built; encoding semantics pinned in `tests/deepbook-pool-whitelist.test.mjs`. | Fixed (needs republish) |

New abort codes to mirror in `lib/server/sui-settlement.ts::ABORT_CODES`:
`107 E_BELOW_MINIMUM` (settlement below `min_settlement_amount`), `304
E_INSUFFICIENT_DEPTH` (now also fires on a sub-`MIN_FILL_BPS` fill), `353
E_POOL_NOT_ALLOWED`, `354 E_TOO_MANY_POOLS`, `355 E_POOL_LIST_EMPTY`.

**S-09 status.** The advisory said "do not repurpose [the DeepBook guard] to
protect pooled funds". S-12 is that repurposing, and the whitelist is what makes
it defensible: the guard now measures a venue the protocol chose rather than one
the caller chose. S-09 stays Advisory — the guard still proves depth on a book
the settlement never trades against, so it is a sanity check on market
conditions, not a proof of execution.

**Publish dependency.** S-11 and the `min_settlement_amount` field on
`ComplianceConfig` are source-level fixes. The deployed package is immutable
and predates both, so batch payouts stay blocked on-chain until the package is
republished and `scripts/set-compliance-config.mjs` runs against the new
`ComplianceConfig`. See `docs/KEY-CEREMONY-RUNBOOK.md` §4.

---

## A-11 BUILT — splash_meter + delegation — 2026-08-19

The ruling of 2026-08-18 is implemented. Three packages now:

```
move/splash_core/     mainnet, IMMUTABLE, no dependencies      14 tests passing
move/splash_meter/    velocity bounds, UPGRADEABLE, no deps    22 tests passing
move/splash_custody/  every Balance<T>, publishes on licence   tests blocked*
```

\* **Resolved 2026-08-18.** All three suites now run — 14 + 22 + 16. The DeepBook
pin moved to `7b48e61b`, the commit immediately before DeepBook's own tests
adopted `std::unit_test::destroy`; the Move stdlib shipped with Sui CLI 1.59.1
exports only `assert_eq` and `assert_ref_eq` from that module, so every later rev
aborted the whole test build before our modules were reached. Verified before
moving: `FLOAT_SCALING` is `1_000_000_000` in both revs (this is the constant
`DEEPBOOK_PRICE_SCALING` must match, and a wrong value there is the Cetus failure
mode), the three view functions the guard calls have byte-identical signatures,
and neither rev sets `published-at` so no on-chain address changed.

**Superseded 2026-08-18.** The Sui CLI was upgraded to 1.77.2 and the pin moved
forward to `daa5a951`. The floor was 1.61.1 — `std::unit_test::destroy` first
shipped there — so the constraint was the toolchain, never DeepBook. All three
suites were re-run on the new CLI before the pin moved and again after, and the
scaling constant and view signatures were re-verified at the new rev.
**The repo now requires Sui CLI >= 1.61.1.**

### What was built

| Piece | Property |
|---|---|
| `spend_meter::SpendMeter` | 24 hourly buckets over a 24h window, rolled forward lazily by the spender's own transaction — Sui has no cron, so any design needing one silently stops working when nobody calls it. |
| Asymmetric limit changes | Tightening is instant. Relaxing costs 48h of public `LimitsProposed` notice and is capped at 4x per step, so a compromised key must announce a raise two days before it can use it. Tightening cancels a queued raise, or the tighten would be theatre. |
| Bootstrap restore | Returning to the ceremony-agreed limits is instant, because recovering from a defensive tighten is not a relaxation — otherwise the 48h cost is exactly the pressure that makes operators avoid tightening at all. |
| `guardian::GuardianCap` | Pause only. Never resume, never spend, never name a recipient. A stolen guardian is a denial of service by construction, which is what makes it safe on an always-on watcher host. Resuming is cold-key work. |
| `settlement.credits` | Per-tenant credit `Table` inside the pool. Cross-tenant drain becomes structurally impossible rather than assert-prevented: a batch can only spend `credits[business_owner]`. |
| `delegation::PayoutDelegation` | The tenant grants it from their own wallet and it lands with the operator. TTL <= 30 days, revocable by owner, by admin, or pool-wide via an epoch bump. |
| Fixed `fee_recipient` | `withdraw_fees` takes no recipient argument. Repointing requires the pool be paused first, so a redirect cannot be slipped between two normal sweeps. |

### Why the delegation replaces `&BusinessAccount` rather than joining it

`settle_batch` is deleted, not fixed. It took `&AdminCap` (cold multisig) and
`&BusinessAccount` (tenant), and a Sui transaction may only name owned objects
belonging to its own sender — two owners, one transaction, impossible. The
delegation carries the tenant's identity, so attribution stays chain-enforced
(closing S-07) while the run becomes signable by one party.

Four independent bounds apply to every batch, all charged UPFRONT before a single
coin moves so a breach aborts the run whole rather than half-paying a payroll:
the delegation must be live; the tenant's own meter; the pool's meter; and the
tenant's credit.

### One design note worth recording

`public(package)` does not cross package boundaries, so the meter's mutators are
`public`. That is safe for a reason worth stating: a `SpendMeter` is a `store`
FIELD, not an object, and Move makes struct fields private to their defining
module. `&mut pool.payout_meter` can only be borrowed inside `settlement.move`,
which gates every borrow behind `AdminCap`, a live delegation, or a
`GuardianCap`. **The mutable reference is the capability.** The same argument
gates guardian minting, via a `&SpendMeter` argument.

### Treasury metering — completed 2026-08-19

Both treasuries now carry the same bounds as the settlement pool, and three
caller-supplied guards were moved into storage:

| Was | Now |
|---|---|
| `smart_treasury::allocate(.., operating_minimum: u64, ..)` — the floor was an ARGUMENT, so `assert!(balance - amount >= operating_minimum)` compared caller against caller. Passing `0` erased it. | **`allocate` deleted.** The floor is a stored field on the treasury; `withdraw` enforces it. Lowering it requires a pause first, so a quiet reduction between two normal withdrawals is not available. |
| `smart_treasury::withdraw(.., recipient: address, ..)` — any destination. | Destination must be on the treasury's allowlist. The last entry cannot be removed (that bricks rather than secures). |
| `smart_treasury::redeem` | Deleted — it was a bare alias for `withdraw`. Two entry points to a treasury, one with a defeatable guard, is worse than one that is correct. |
| `dual_treasury::emergency_sweep(.., recipient: address, ..)` — caller-chosen destination for the WHOLE balance, on the path reachable precisely when things are already going wrong. | Destination fixed at buffer creation. In an event log a redirected sweep is indistinguishable from a legitimate one, which is what made this the worst of the three. |
| `dual_treasury::settle_usdt(.., kyc_tier: u8, min_kyc_tier: u8, ..)` — **both sides of the compliance comparison came from the caller.** `kyc_tier: 5, min_kyc_tier: 0` always passes. | The threshold is stored on the buffer, so the assert compares a caller-supplied claim against a stored policy. Lowering it requires a pause. |

All three value paths (`smart_treasury::withdraw`, `dual_treasury::settle_usdt`,
`dual_treasury::emergency_sweep`) now charge a `SpendMeter`, and each object can
mint its own pause-only `GuardianCap`.

### Still open

- A-15 (no beneficiary screening) is untouched: delegated batches still pay
  unscreened, caller-supplied addresses.
- The DeepBook pin is held ~7 months behind `main` purely by the CLI's stdlib.
  Upgrading the Sui CLI lifts the constraint and is needed for gRPC publishing
  anyway, so both should move together.

---

## A-11 / A-12 design ruling — 2026-08-18

Three rival designs were argued by independent advocates, each cross-examined by
an agent who did not write it, then judged. All three cross-examiners returned
`build_with_changes` — no design survived intact.

### The finding that reframed the problem

**`settle_batch` and `settle_sui_batch` are already UNCALLABLE after the key
ceremony, and the M-04 fix in commit `188af29` is what made them so.**

`business_account.move:102` does `transfer::transfer(account, owner)`, so
`BusinessAccount` is address-owned by the tenant. `AdminCap` goes to the cold
multisig. A Sui transaction can only name owned objects belonging to its
*sender* — so one transaction cannot supply both, and the
`owner == tx_context::sender` assert added for S-07 pins the sender to the
tenant, which excludes the `AdminCap` input entirely.

The security property was right; the shape was wrong. Runbook §1 option A
("accept it — batch becomes a multisig-signed operation") is therefore not
"safest but inconvenient", it is **not executable**. Correcting that is the
single most valuable output of the exercise.

### Ruling

Adopt a hybrid: **spend meters + credit segregation + tenant delegation**, with
the delegation *removing* `&BusinessAccount` from the batch signature rather than
adding a capability beside it.

| Component | Package | Purpose |
|---|---|---|
| `splash_meter::spend_meter` | new, upgradeable | Sliding-window ceiling: per-tx cap, per-window cap, lazy roll-forward (Sui has no cron, so the spender's own transaction advances the window). Relaxations cost 4x per step and 48h of public `LimitsProposed` notice. |
| `splash_meter::guardian` | new | `GuardianCap`, pause-only, never resume, never spend — safe for an automated watcher, and a stolen one is a denial of service rather than a theft. |
| `settlement::credits` | custody | Per-tenant credit ledger inside the pool. Makes cross-tenant drain structurally impossible rather than assert-prevented. |
| `PayoutDelegation` | custody | Tenant grants it from their own wallet; it lands with the operator. `settle_batch_delegated` takes the delegation *instead of* `&BusinessAccount`, which is what makes a batch executable by one signer at all. TTL <= 30 days. |
| Fixed `fee_recipient` / `sweep_recipient` | custody | Set at pool creation by the multisig. `withdraw_fees` takes no recipient argument. |

Sized against real volume — RM 250k/month is roughly USD 2.5k/business day — a
USD 50k/24h pool ceiling is ~20x actual flow. It will not bind in normal
operation, and it caps a total compromise at $50k/day instead of everything in
one PTB.

### Custody topology (A-12)

| Address | Holds | A compromise yields |
|---|---|---|
| **M** cold 2-of-3 multisig | `TreasuryCap` | Everything *metered* — bounded per window, only to fixed recipients; raising a ceiling costs 48h of public notice. Cannot drain the pool: `settle_batch_delegated` needs a delegation M does not hold. |
| **A** governance multisig | `AdminCap` | KYB verification and its withdrawal, compliance-side account freezing, per-account ceilings, limit and allowlist changes, guardian minting, anchor-cap rotation. **Moves no value at all** — `scripts/check-treasury-cap.mjs` fails the build if an `AdminCap` function learns to split a balance. |
| **H** hot operator server | `AnchorCap`, gas key, tenants' delegations | False peg readings and forged anchors — an integrity problem, not a solvency one. Payouts only to addresses a tenant already named, bounded by two meters. |
| **G** guardian host, separate machine | `GuardianCap` | Denial of service. Zero coins, by construction. |
| **C** compliance custodian | `ComplianceCap` | Pause, a tightening, or removing a venue. **Cannot loosen anything** — subtractive by type, enforced by `scripts/check-compliance-subtractive.mjs`. Moves no funds. |

Phase 6 split **M** in two. `AdminCap` used to be both the money key and the
governance key, so a governance action needed the money ceremony and the
answer to "who can move funds?" was thirty-odd functions. `TreasuryCap` is now
the only capability through which value leaves a custodial object; `AdminCap`
governs and cannot spend.

**Every revocable capability can now be killed (Phase 7).** `AnchorCap` and
`ComplianceCap` carry a generation checked against a shared `CapRegistry` on
every use, and `AdminCap` can bump it — which mints one replacement and kills
every outstanding cap of that kind in the same transaction. That closes the two
holes Phase 6 created and named: a LOST anchor cap no longer bricks anchoring
in an immutable package, and a STOLEN cap no longer relies on "off-chain
rejection of the retired id", which was a hope rather than a control. There is
no timelock and `cap_registry`'s module comment argues why at length.
`AdminCap` and `TreasuryCap` have no generation — they are multisig-held, and
`AdminCap` is the key that arms every break-glass, so it cannot be the subject
of one.

**May `AdminCap` and `AnchorCap` share an address? No — never.**
`AnchorCap` exists *because* `update_peg` fires every ~30s, roughly 2,880
signatures a day from an internet-facing host. Co-locating money or governance
authority there is precisely the condition A-12 records.

**They currently do.** `attestationCapObjectId()` fell back to `adminCapId`, and
`.env.example` shipped `SPLASH_ATTESTATION_CAP_ID` empty. **Fixed in this
commit** — the fallback now throws. It was convenient exactly because it made
the split invisible, which is what made it the bug.

`compliance_config::create` transfers `ComplianceCap` to `ctx.sender()`, i.e. to
M. Rotating it to C via `transfer_cap` is a **required ceremony step that was
not in the runbook**.

### Shipped now (all three impossible after the immutable publish)

| ID | Finding | Status |
|----|---------|--------|
| M-07 | `verify_business` asserts `!is_verified` and no de-verification path existed anywhere. An account verified on mainnet was verified **forever**, in an immutable package — a business whose KYB lapses, or which turns out to be a shell, could never be un-verified, and `settle_payment` gates on exactly that flag. **Fixed**: `business_account::revoke_verification` (abort 5), resetting `risk_score` so a stale score cannot later be read as a current assessment. | Fixed |
| M-08 | `set_paused` is `ComplianceCap`-only; that cap is `key` with no `store`, minted once, movable only by its own holder. Losing it **while paused** deadlocks `assert_pegged` and therefore every settlement path, permanently, with no recovery. **Fixed**: `compliance_config::admin_set_paused` break-glass. This does weaken the two-key pause — a permanent unrecoverable brick is the strictly worse outcome. | Fixed |
| M-09 | `confirm_payment_intent` took `Coin<SUI>` — a USD corridor settling in a volatile asset, so SUI movement between intent and confirmation changed what the recipient received. **Fixed**: generic `Coin<T>` **with the asset bound at creation** and asserted at confirmation (abort 414). A bare generic would have been strictly worse than the hardcode: the only amount check is `value(payment) >= amount_usd`, so any coin type could discharge the obligation — 100,000,000 units of a worthless token for a 100 USDC debt. | Fixed |

### Not yet built

`splash_meter`, credit segregation and `PayoutDelegation` are a multi-package
Move project with its own test suite; the ruling's own build order puts the
settlement rewrite last and largest. They land before `splash_custody` publishes,
which is Phase 2 (the custody tier; `PHASE_2_CUSTODY` in the code) — there is no Phase 0 exposure, because custody has no bytecode
on chain.

### What none of this protects against

- A compromised cold multisig still extracts one window per window, indefinitely.
  The bound buys time; monitoring is what spends it.
- An attacker who owns the server **and onboards a shell tenant** through the KYB
  queue they themselves operate. Credit segregation caps this at what the
  attacker funded — a laundering channel, not theft of other tenants' money.
  Nothing in Move fixes the KYB approval process.
- A-15 (no beneficiary screening) is untouched: delegated batches still pay
  unscreened, caller-supplied addresses.
- Sui has no timelock. The 48h delay is a *detection window*, worthless if nobody
  watches `LimitsProposed`.

---

## Mainnet cutover — package split & M1/M3 — 2026-08-17

**The structural change.** `move/` split into two packages. `splash_core`
(business_account, payment_intent, audit_anchor, receipt_v2, compliance_config,
peg_monitor) publishes to mainnet; `splash_custody` (settlement, smart_treasury,
dual_treasury, liquidity_guard) publishes only when the Labuan e-money licence is
granted (superseded in v2: D11 retires `splash_custody` from the mainnet path
for good; testnet only). Non-custody stops being an assert someone can forget and becomes a
property of the type system: **no struct in `splash_core` holds a `Balance<T>`**,
enforced by `scripts/check-core-no-balance.mjs` in CI
(`.github/workflows/core-invariant.yml`) and in `npm run lint`.

**The checker was itself defeated once and rebuilt.** An adversarial review
compiled a complete client omnibus into `splash_core` — per-client balances in a
`Table`, a `vector<Coin>`, an `Option<Balance>`, an aliased `Balance as Ledger`,
a field split across two lines, a single-line struct, and a module in a
subdirectory the non-recursive scan never opened — while v1 reported "invariant
holds". v1 matched only `name: Type<` at the start of a physical line. The
rewrite parses struct bodies out of comment-stripped source and matches value
types at any nesting depth under any local alias, walks `sources/` recursively,
and cross-checks its module count against the compiler's bytecode output. All
seven bypasses are pinned in `tests/core-invariant-check.test.mjs`. A control
quoted as evidence has to actually hold, so it is now tested like one.

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| M-01 | High | `payment_intent::create` returned `(PaymentIntent, SettleReceipt)` and minted the receipt with `settled_at: now` and **no `Coin` anywhere in the function**. The type asserted a settlement that had not happened, and `audit_anchor` would anchor that assertion on chain as proof of payment — a forgeable receipt. **Fixed**: `create` returns `PaymentIntent` only; `SettleReceipt` is minted solely by `confirm_payment_intent`, which consumes a `Coin<T>`. Pinned by `core_invariants_tests`. | Fixed |
| M-02 | Medium | `unpack_settle_receipt` was `public(package)`, so any module in the package could consume a `SettleReceipt` and discard the fields without anchoring — breaking "every settlement is anchored" silently. **Fixed**: `audit_anchor::AnchorWitness`, constructible only inside `audit_anchor`, is now required (abort 413). Note the witness is generic + module-checked rather than named directly: `audit_anchor` already depends on `payment_intent` and Move forbids circular imports, so binding on the witness type's defining module achieves the same restriction. | Fixed |
| M-03 | Medium | `settlement::deposit` was open to anyone and recorded nothing — the pool could not be reconciled, a deposit could not be attributed or returned, and an unsolicited deposit into a shared object that pays third parties is an obvious layering vector. **Fixed**: AdminCap-gated, emits `PoolFunded{pool_id, depositor, amount, new_balance, funded_at_ms}`. | Fixed |
| M-04 | Medium | `settle_batch` / `settle_sui_batch` asserted `is_verified` but omitted the `owner == sender` binding that `settle_payment` has, leaving S-07's event attribution operator-trusted. **Fixed**: binding mirrored into both. **Consequence:** batches must now be signed by the business owner rather than driven unilaterally by the operator's `AdminCap`. That is a real change to the batch operating model, made deliberately — an operator who can both move pooled funds and choose whose name is on the payout is the authority concentration S-10 exists to break up. The delegation design (a bounded `SettlementCap`, cf. A-11) lands before custody publishes. | Fixed |
| M-05 | Info | `'X-Source-Entity': 'splash-my'` on every Labuan settlement call, plus `intercompanyRef` and MYR conversion aliases — all asserting a Malaysian leg that the licence perimeter does not have. Splash Labuan receives USD only. **Fixed**: `'splash-labuan'`; the MYR aliases and the intercompany field removed. | Fixed |
| M-06 | Info | `content/money-path.ts` named Hata as the conversion venue without Hata being a partner of record, against the file's own rule. **Fixed**: removed, and `splashIsParty: boolean` added to every step so `tests/money-path.test.mjs` asserts the header claim ("Splash orchestrates — we never hold your funds") as data: exactly one step may have `splashIsParty === true`, and it moves no money. | Fixed |

**Dependency posture.** `splash_core` now has **no third-party Move
dependencies** — the DeepBook liquidity guard moved to custody, where the pooled
funds it protects actually live. Two consequences: the mainnet package's
dependency surface is the Sui framework and nothing else (Cetus was drained
through a third-party math library, and the strongest defence against that class
is not having the dependency); and `sui move test` runs, which it previously
could not — the pinned DeepBook rev ships test files that fail to compile against
this toolchain, aborting the test build before our modules were reached. **Move
test coverage went from 0 runnable tests to 10 passing.**

**Upgrade policy: `splash_core` publishes IMMUTABLE.** The `UpgradeCap` is burned
at publish. A settlement contract whose logic cannot change is a stronger
regulatory position than one under multisig, where the question becomes "who
holds the keys" and the answer is a custody procedure taken on trust. The cost is
real and accepted: a post-publish bug requires a fresh publish and a
re-bootstrap of every shared object. See `STATUS.md`.

---

## Adversarial pass — 2026-08-13 (application tier)

**Scope**: 24 agents across two workflows — Move authority, Move arithmetic,
server authority, off-chain money path, ABI drift, compliance state machines,
then a second sweep modelling three real incidents: **Step Finance** (Jan 2026,
~$30-40M — compromised executive *devices*, not a contract bug), **Cetus** (May
2025, $223M on Sui — `checked_shlw` used the wrong overflow threshold and Move's
`<<` truncates instead of aborting), and **Hedgey** ($44.7M — unvalidated
caller-supplied parameters). Every finding was put to an independent refuter;
what follows survived.

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| A-01 | Critical | The 6-digit payout code on both money routes was validated with `/^\d{6}$/` and nothing else — no secret, no verification, no MFA dependency in the repo. `000000` authorized a payroll run out of the shared `SettlementPool`. `requireTotp` was persisted, rendered, and read by no authorization path. **Fixed**: RFC 6238 on `node:crypto`, pinned against the RFC 4226 published vectors, single-use per step, fail-closed when unenrolled. | Fixed |
| A-02 | High | `transfers/authorize` took the paying account from `body.businessAccountId`; `GET /api/ledger` with no `accountId` returned every account's entries. Enumerate, then debit. **Fixed**: account derived from the session in all four routes; a foreign id gets 403. | Fixed |
| A-03 | High | A stablecoin funding session CREDITed the payer's ledger but the route DEBITed only on the `held` branch — one deposit funded two payouts. **Fixed**: payer debited for every source, non-negative assert before settlement. | Fixed |
| A-04 | High | Every settlement PTB called `update_peg(0,0)` as command #1 and `settle_payment` — which calls `assert_pegged` — as command #2. **The on-chain peg circuit breaker read a perfect peg the same transaction had written one instruction earlier.** It could not fail. **Fixed**: the pushed value is measured; a fabricated `$1.00` from the Pyth mock fallback is never attested; with no live reading the command is omitted so `PegState` goes stale and `assert_pegged` aborts (302). | Fixed |
| A-05 | High | Admin session tokens were `nonce.hmac(nonce)` — no issue time, no identity, no revocation. A copied cookie verified forever; sign-out cleared only the browser's copy. **Fixed**: signed issue time enforced server-side, subject bound, `revokeAllAdminSessions()`. | Fixed |
| A-06 | High | `SPLASH_TEST_RECIPIENT_ADDRESS` unconditionally overrides the beneficiary on every live path, per row in a batch — and was writable at runtime via `PUT /api/admin/contracts`, whose entire authorization was "is there a session". A stolen admin cookie redirected every payout, persisted to disk, dashboard unchanged. **Fixed**: env-only (403 from that route), refused on mainnet, logged. | Fixed |
| A-07 | High | Batch authorization minted a fresh batch per call — a dropped response plus a re-submit paid every recipient twice. **Fixed**: idempotency key. | Fixed |
| A-08 | Medium | `perTransferLimitUsd` / `dailyLimitUsd` / `approvalThresholdUsd` / `requireDualApproval` were persisted, cross-checked and rendered — and enforced nowhere. **Fixed**: enforced in both routes; daily volume summed from the ledger. | Fixed |
| A-09 | Medium | `settle_batch` looped an unbounded caller vector (one event + one created Coin per row) under a flat 10,000,000 MIST budget. Above ~1,023 rows Sui's 1,024-event / 1,024-command ceilings make it unexecutable at any budget. **Fixed**: `MAX_BATCH_ROWS = 256` (abort 108), gas scales with row count. | Fixed |
| A-10 | High | `ComplianceConfig.paused` gates `settle_payment`/`settle_batch`, but the live customer path is `payment_intent::confirm_payment_intent`, which imports neither `compliance_config` nor `peg_monitor` — pausing halted batches while transfers kept executing. **Mitigated off-chain** (both routes check `paused`); the chain-side guard needs the republish. | Mitigated |
| A-11 | High | **Nothing bounds an `AdminCap` call.** `withdraw_fees`, `smart_treasury::withdraw`, `allocate` (whose `operating_minimum` is a caller-supplied `u64` — pass `0`) and `settle_batch` have no amount cap, velocity limit, cooldown or timelock. One PTB signed with the operator key drains the pool, the fees and the treasury. This is the Step Finance shape exactly. | **Mitigated** — `splash_meter` bounds pooled outflow per window with asymmetric limit changes; Phase 6 moved every value-out function off `AdminCap` onto `TreasuryCap` (five functions, enforced by `scripts/check-treasury-cap.mjs`) and gave each business account a 24h ceiling. Not closed: the ceilings are still parameters someone with the right cap can raise, and `allocate`'s caller-supplied floor is unchanged. |
| A-12 | High | The S-10 cap split is **not in effect at runtime**: `anchorCapObjectId()` fell back to `adminCapId`, `.env.example` shipped the key empty, and `recordBatchSettlementOnSui` passed `SPLASH_ADMIN_CAP_ID` directly. The hot key is still the money authority until the ceremony runs. | **Open** — the fallback is gone (an unset `SPLASH_ANCHOR_CAP_ID` now stops the peg refresh rather than borrowing the money key), and Phase 6 removed the reason it mattered most by moving value out of `AdminCap` entirely. The batch PTB no longer takes `AdminCap`: it takes the anchor cap and a tenant's payout delegation (`lib/server/sui-settlement.ts:1528-1532`). Still open until the republish and the ceremony actually run. |
| A-13 | High | Seal enforces no per-tenant policy: one global allowlist object, and the operator key decrypts every blob ever sealed. Seal also falls open to a hardcoded AES key while Walrus publishes for real. `/api/audit/[intentId]` has no ownership check. | **Open**, in part. `/api/audit/[intentId]` now reads only the session org's transfer and receipt (`app/api/audit/[intentId]/route.ts:14-17, 58-62`, commit `50542610`). The stand-in AES key is used only outside `NODE_ENV=production`, or when `USE_MOCK_APIS` or `NEXT_PUBLIC_DEMO_MODE` is true (`lib/server/seal.ts:36-38, 186-203`; `lib/server/runtime-mode.ts:5-9, 27-29`); a production deployment with neither gets live Seal or a refusal. Still open: every seal id derives from one global policy object (`lib/server/seal.ts:132`), and live decryption signs with the operator key (`lib/server/seal.ts:160`). |
| A-14 | Medium | Batch rows are USD micro-units passed as SUI MIST on a `SettlementPool<SUI>`. $100 becomes 100,000,000 MIST = 0.1 SUI. Recipients are underpaid and the on-chain minimum is effectively disabled on that path. Correct for 6-decimal USDC; wrong for the 9-decimal SUI pool. Needs a product decision on what the SUI pool represents. | **Open** |
| A-15 | Medium | No beneficiary screening on either payout path — Elliptic is referenced but is a stub, and the compliance engine is wired only to the 0xWal proposal route. Batch pays unscreened, caller-supplied raw Sui addresses. | **Open**. The USDC wallet lane now screens: a wallet address is checked against a sanctions list when it is saved (`app/api/recipients/route.ts:92-116`, `lib/server/wallet-screening.ts`), and a send is refused unless the stored verdict is CLEAR or an admin's attestation (`lib/server/stablecoin-send.ts:141-142`). The batch path still pays unscreened addresses. |
| A-16 | Medium | Operator-signed PTBs are never serialized and never `setGasPayment` — concurrent `after()` callbacks sign different transactions over the same owned gas coins. Best case a spurious FAILED transfer; worst case the operator's whole coin set locks for an epoch. | **Open** |
| A-17 | High | Nothing ever writes `KYB_SUBMITTED` or `KYB_PROVIDER_APPROVED`, so `approveOrgKybOnChain` always throws and `verify_business` is unreachable. `readOrgKybState` also fails open to `ACTIVE` when the org row is missing, returning a success shape with `digest: ''` for a verification that never happened. | **Mitigated** (`b523516`, `2d444d6`): fixed with `FEATURE_KYB_GATE=true`, open with the gate off (the default). Uploading documents moves the org to `KYB_SUBMITTED` as SYSTEM (`app/api/kyb/upload/route.ts:103`); the signed Sumsub webhook moves it to `KYB_PROVIDER_APPROVED` or `REJECTED` as PROVIDER (`app/api/webhooks/sumsub/route.ts:108-118`); staff approval then runs `approveOrgKybOnChain` (`app/api/admin/kyb/[id]/route.ts:62-66`). With `FEATURE_KYB_GATE=true`, a missing org row reads `REGISTERED` (`lib/compliance/org-kyb.ts:54-60, 80`). Residue: with the gate off, a missing row still reads `ACTIVE`, so `approveOrgKybOnChain` returns `digest: ''` for it (`lib/compliance/org-kyb.ts:132-134`). |
| A-18 | Medium | `/api/kyb/cases/latest` matches on public `businessName` / `registrationNumber` with no org check, returning review notes, risk tier, Sumsub applicant id and every document's filename + SHA-256. | **Fixed** (`99bb67d`). The route takes no parameters and reads the org from the session (`app/api/kyb/cases/latest/route.ts:45-57`); `findLatestKybCase` lists only that org's cases (`lib/server/kyb.ts:243-274`). |
| A-19 | Medium | `resolveAuthorityForSession` auto-provisions a missing user as `checker` → `APPROVER`, so any email that can mint a session becomes a valid second signature. zkLogin also hardcodes `DEFAULT_ORG_ID` and makes nonce binding optional at the client's discretion. | **Open** |

**What the incidents imply here.** Step Finance died on key custody, not code —
which makes **A-11 and A-12 the highest-value open items in this repo**: the cap
split is written but not in effect, and even once it is, no value-moving Move
function has a ceiling, so a single compromised hot key still drains everything
in one transaction. Cetus died on a guard whose constant was wrong; the
equivalent check here passed — `DEEPBOOK_PRICE_SCALING = 1e9` matches DeepBook's
own `FLOAT_SCALING`, verified against the pinned dependency source, and the fee
math already routes through OpenZeppelin's checked `u64::mul_div`. The
denomination defect that did surface (**A-14**) is a units error at the
application boundary, not in the contract arithmetic.

---

**Numbering note.** `S-06`/`S-07` are the 2026-07-13 advisories above
(`AdminCap` abilities; `settle_batch` event attribution). The cap split and the
DeepBook guard fix are `S-10`/`S-11` — module doc-comments use those IDs.

---

## Findings

### C-01 · `smart_treasury::add_usdc` always aborts on non-zero coins
**Severity**: Critical
**Status**: Open
**Location**: `move/sources/smart_treasury.move:51-61`

The function adds the coin's value to `treasury.usdc_balance` (a `u64` counter), then calls `coin::destroy_zero(usdc_coin)`. `destroy_zero` aborts if the coin's value is non-zero — the only path that succeeds is depositing a coin of value 0, in which case the counter is also incremented by 0.

In effect, the treasury contract **cannot accept any USDC at all**. Worse, the function pretends to credit the deposit before aborting, which would mislead off-chain callers reading the partial transaction trace.

The type parameter is also wrong — the function accepts `Coin<SUI>` but the field name and comments say USDC.

**Recommendation**: Rewrite to actually store the deposit in a `Balance<USDC>` field on `SmartTreasury`. Use a proper type parameter (`Coin<USDC>`). Emit a `UsdcDeposited` event. Remove the `destroy_zero` call. Mirror the pattern in `dual_treasury::deposit`.

---

### C-02 · `SmartTreasury` does not actually hold any value
**Severity**: Critical
**Status**: Open
**Location**: `move/sources/smart_treasury.move:13-20`

`SmartTreasury` only contains `u64` counters (`usdc_balance`, `usd_balance`). There is no `Balance<T>` field on the struct. All "balances" are accounting fiction with no on-chain backing.

`rebalance_treasury` increments/decrements `usd_balance` based on an admin-supplied `amount_usd` argument — there is no movement of any actual coin. A compromised admin can mint arbitrary phantom balances; the dashboard treasury figure is unreliable.

**Recommendation**: Add `usdc_balance: Balance<USDC>` and `usd_balance: Balance<USD>` (or whatever stable type represents USD on Sui). All mutations must move real balance via `balance::join` / `balance::split`. Remove the `u64` counters or expose them as views derived from `balance::value(&field)`.

---

### C-03 · `payment_intent::create_payment_intent` accepts a spoofed `sender`
**Severity**: Critical
**Status**: Open
**Location**: `move/sources/payment_intent.move:26-50`

The function takes `sender: address` as a caller-supplied parameter rather than reading it from `tx_context::sender(ctx)`. Any caller can therefore create a `PaymentIntent` claiming any address as the sender.

Downstream, `recipient` is also caller-supplied — combined, an attacker can fabricate intents that look like they came from victim A and pay attacker B, and these intents will appear in off-chain indexers as if A authorized them. Even if `confirm_payment_intent` requires the right coin, the intent itself is a falsifiable record on-chain.

**Recommendation**:
```move
public entry fun create_payment_intent(
    recipient: address,
    amount_usd: u64,
    target_currency: String,
    fx_rate_usd_local: u64,
    ctx: &mut TxContext,
) {
    let sender = tx_context::sender(ctx);
    // ...
}
```
Same pattern applies anywhere `address` is taken as an argument that should be the caller.

---

### H-01 · `payment_intent` uses `epoch_timestamp_ms` instead of `Clock`
**Severity**: High
**Status**: Open
**Location**: `move/sources/payment_intent.move:34, 59, 72`

`tx_context::epoch_timestamp_ms(ctx)` returns the epoch start time, which only advances at epoch boundaries (~24 hours on Sui mainnet). The 5-minute expiration window (`now + 300_000`) is therefore meaningless — within the same epoch, every `confirm_payment_intent` and `cancel_payment_intent` call sees the same "now". Expired intents may remain confirmable for hours; pending intents may show as expired immediately at an epoch boundary.

**Recommendation**: Take `clock: &Clock` parameter and call `clock::timestamp_ms(clock)`. Match the pattern already used in `peg_monitor` and `settlement`.

---

### H-02 · `payment_intent::confirm_payment_intent` has no sender authorization
**Severity**: High
**Status**: Open
**Location**: `move/sources/payment_intent.move:53-68`

The intent is a `key + store` shared object after `transfer::share_object`. Any address can therefore call `confirm_payment_intent` with any coin ≥ `intent.amount_usd`. This enables griefing — a third party can confirm an intent at the cheapest possible payment, draining the recipient's expected upside, or front-running with a cheaper coin denomination.

**Recommendation**: Add `assert!(tx_context::sender(ctx) == intent.sender, E_UNAUTHORIZED);`. Or: require the caller to hold a `PaymentApprovalCap` minted at intent creation and given only to the sender.

---

### H-03 · `payment_intent::confirm_payment_intent` over-charges silently
**Severity**: High
**Status**: Open
**Location**: `move/sources/payment_intent.move:61-67`

The check is `amount >= intent.amount_usd`, then the **entire** payment coin is forwarded to the recipient. If the caller supplies a 100 SUI coin to confirm a 1 SUI intent, the recipient receives 100 SUI and there is no refund of the 99 SUI overpay.

**Recommendation**: Split the coin: `let to_pay = coin::split(&mut payment, intent.amount_usd, ctx);` then transfer only `to_pay` to recipient and return `payment` to sender (or destroy if zero). Pattern already used in `settlement::settle_payment` for the fee split.

---

### H-04 · `business_account::submit_application` has no rate limit
**Severity**: High
**Status**: Open
**Location**: `move/sources/business_account.move:39-59`

Anyone can call `submit_application` unlimited times, each call mints a new `BusinessAccount` UID. This is a denial-of-service vector against the off-chain Sumsub indexer and inflates the object table.

**Recommendation**: Either gate creation behind a fee (a small SUI burn deters spam), or require a one-shot capability minted by AdminCap. At minimum, enforce one-application-per-sender by storing applicant addresses in a shared `Table<address, bool>` and asserting they're not already present.

---

### H-05 · `peg_monitor::init_peg_state` initializes deviation at 0 with a current timestamp
**Severity**: High
**Status**: Open
**Location**: `move/sources/peg_monitor.move:47-56`

After init, `assert_pegged` passes immediately because (a) deviations are 0 and (b) `last_update_ms = clock::timestamp_ms(clock)`. The first ~60 seconds after init, settlements proceed against zero peg data — without the operator daemon ever having pushed a real Pyth reading.

**Recommendation**: Initialize `usdc_deviation_ppm: MAX_DEVIATION_PPM + 1` and `usdt_deviation_ppm: MAX_DEVIATION_PPM + 1` so `assert_pegged` aborts until the first real `update_peg` lands. Or set `last_update_ms = 0` so staleness check fails until first update.

---

### H-06 · Fee gouging via unbounded `FEE_BPS`
**Severity**: High
**Status**: **Fixed** (2026-05-29)
**Location**: `move/sources/settlement.move`

The contract previously hardcoded `FEE_BPS = 150` (1.50%) while the off-chain quote engine, dashboards, and marketing all advertised 0.80%–1.10%. There was no way to align them without redeploying. Worse — any future change to the constant required a full upgrade.

**v2 note (Amendment A1, 24 Oct 2026):** this finding is custody-era history. `splash_custody` is retired from the mainnet path, `lib/fx/corridors.ts` carries no fee any more, and the v1 testnet custody path is handed the A1 bank tier's rate (at most 100 bps). On the v2 paths no caller passes a rate: the fee is computed on chain by `splash_core::fee_config` under a 100 bps ceiling (`docs/v2/fees.md`).

**Resolution**: `settle_payment` and `settle_batch` now take `fee_bps: u64` as a parameter, bounded by `MAX_FEE_BPS = 200` via `assert!(fee_bps <= MAX_FEE_BPS, E_FEE_EXCEEDED)`. Per-corridor fees are defined in `lib/fx/corridors.ts` and passed by the off-chain settlement layer. The contract emits `fee_bps` in `PaymentSettled` and `PaymentExecuted` for full auditability. See `lib/fx/corridors.ts`, `lib/server/sui-settlement.ts`, and `lib/sui/contracts.ts` for the off-chain pieces.

---

### M-01 · `audit_anchor::anchor_audit_hash` has no caller authorization
**Severity**: Medium
**Status**: Open
**Location**: `move/sources/audit_anchor.move:20-34`

Anyone can call this entry function and create `AuditAnchor` shared objects with arbitrary hashes. The audit trail can be polluted with junk anchors that look identical to real ones to a naive off-chain reader.

**Recommendation**: Gate with `AdminCap` (matching `peg_monitor::update_peg`), or accept a `BusinessAccount` reference and assert `is_verified`. Add a `business_account_id: address` field to the anchor so off-chain indexers can filter by tenant.

---

### M-02 · `audit_anchor::verify_anchor` is tautological
**Severity**: Medium
**Status**: Open
**Location**: `move/sources/audit_anchor.move:37-39`

`verify_anchor(anchor, hash)` simply returns `anchor.audit_hash == hash` — i.e. it tells you whether the value you supplied matches the value already on the anchor you read. This provides no independent verification; off-chain callers can do the comparison themselves without calling the contract.

**Recommendation**: Either remove this function (misleading), or change it to verify against a Merkle root or Walrus CID that the anchor commits to — i.e. give it meaning beyond a string equality check.

---

### M-03 · `receipt_v2::link_audit_anchor` lacks authorization
**Severity**: Medium
**Status**: Open
**Location**: `move/sources/receipt_v2.move:56-62`

The receipt is a shared object; any caller can mutate `audit_anchor_id` to point to a different (possibly fake) anchor. A receipt's audit linkage is therefore not tamper-evident on chain.

**Recommendation**: Require `AdminCap` OR `assert!(tx_context::sender(ctx) == receipt.sender)`. Better: link the anchor at receipt creation and remove the post-hoc setter entirely (immutable receipts).

---

### M-04 · `smart_treasury::rebalance_treasury` shares an object per call
**Severity**: Medium
**Status**: Open
**Location**: `move/sources/smart_treasury.move:64-93`

Every rebalance call creates a new `TreasuryRebalance` shared object via `transfer::share_object`. Over time this fills the object table with one shared object per rebalance event — expensive in storage and gas, hard to query.

**Recommendation**: Replace with an event: `event::emit(TreasuryRebalanced { ... })`. Events are cheap, queryable from indexers, and don't add to the object table.

---

### M-05 · Magic abort codes throughout scaffold modules
**Severity**: Medium
**Status**: Open
**Location**: `payment_intent.move:58, 59, 62, 72` · `smart_treasury.move:56, 70, 77`

Scaffold modules use bare integers (`assert!(..., 0)`, `assert!(..., 1)`, etc.) instead of named `const E_FOO: u64 = N;` constants. Diagnosing reverts requires reading the source — off-chain error mapping (see `lib/server/sui-settlement.ts::ABORT_CODES`) has no way to associate human-readable strings with anonymous codes.

**Recommendation**: Define named constants at module top, matching the `E_FOO` convention used in `settlement.move` and `peg_monitor.move`. Add the new codes to `lib/server/sui-settlement.ts::ABORT_CODES`.

---

### M-06 · `business_account::AdminCap` is single-key with no rotation
**Severity**: Medium
**Status**: Open (architectural)
**Location**: `move/sources/business_account.move:34-36`

`init` mints one `AdminCap` and transfers it to the deployer. There is no multi-sig, no time-locked rotation, no recovery path. If the deployer's key is lost, every admin function (peg updates, KYB verification, treasury seed) becomes uncallable forever — protocol bricked.

**Recommendation**: Wrap `AdminCap` usage behind a multi-sig pattern at the address level (use Sui multisig), or build an on-chain governance module with N-of-M keyholders that can mint replacement AdminCaps after a timelock. At minimum, document the operational policy: where the key lives, who has access, what the rotation cadence is, what the recovery plan is if the key is lost.

---

### M-07 · `dual_treasury` resets TTL on every deposit
**Severity**: Medium
**Status**: Open
**Location**: `move/sources/dual_treasury.move:62-63`

`deposit` overwrites `buffer.intake_ms = now_ms` on each call. Old funds in the buffer get a fresh TTL whenever new funds are added — meaning a 29-minute-old position can be reset to 0 by depositing 1 wei of USDT, indefinitely keeping funds past the intended `USDT_MAX_HOLD_MS` ceiling. The `emergency_sweep` trigger never fires for actively topped-up buffers.

**Recommendation**: Track per-batch intake (e.g. `Table<u64, u64>` keyed by batch id → intake_ms) and enforce TTL per oldest batch. Or: forbid deposits when `buffer.balance > 0` — force one-batch-at-a-time accounting.

---

### M-08 · `dual_treasury` parameter naming hides cap discard
**Severity**: Medium
**Status**: Open
**Location**: `move/sources/dual_treasury.move:54, 75, 99`

Functions take `cap: &AdminCap` then do `let _ = cap;`. This works (the borrow still requires the cap to exist), but the pattern is non-idiomatic and easy to overlook in review — a future change could remove the `let _` line and the borrow would optimize away, breaking access control silently.

**Recommendation**: Use `_admin: &AdminCap` parameter name (Move/Rust convention for "intentionally unused reference"). Match `peg_monitor::update_peg` style.

---

### L-01 · `settlement.move` `MAX_FEE_BPS = 200` may be too loose
**Severity**: Low
**Status**: Open (advisory)
**Location**: `move/sources/settlement.move:23`

Current corridor fees are 80–110 bps. The 200 bps (2%) ceiling is roughly 2× headroom — defensive but allows a misconfigured quote engine to charge double the highest legitimate fee without aborting.

**v2 note (Amendment A1):** custody-only. The v2 fee ceiling is 100 bps, written into `splash_core::fee_config` and `splash_spend` and held equal by `check:fees`.

**Recommendation**: Tighten to 150 bps if no genuine 1.5%+ corridors are planned. Or: emit a `HighFeeWarning` event when `fee_bps > 120` so off-chain monitors can alert on suspicious quotes.

---

### L-02 · `peg_monitor::assert_pegged` aborts on either-stablecoin break
**Severity**: Low
**Status**: Open (intentional conservatism)
**Location**: `move/sources/peg_monitor.move:83-89`

A USDC-denominated settlement aborts if USDT's peg is broken (and vice versa). The conservative posture is reasonable — broad peg stress usually correlates — but it does mean USDT operational issues block USDC flow.

**Recommendation**: Add `assert_pegged_for<T>(state, clock)` variants that only check the relevant stablecoin. Keep the joint check as the default for batch settlements that may mix types.

---

### L-03 · No pause / circuit breaker
**Severity**: Low
**Status**: Open (architectural)
**Location**: All modules

There is no `paused: bool` field gated by AdminCap that would let operators halt settlements in an incident. The only emergency lever is `peg_monitor::update_peg` with deliberately bad data (which halts all settlements but is hacky).

**Recommendation**: Add `PauseState { paused: bool }` shared object and `assert!(!pause.paused, E_PAUSED)` at the top of every settlement entry function. Gate `set_pause` with `AdminCap`.

---

### L-04 · `business_account::submit_application` uses `#[allow(lint(self_transfer))]`
**Severity**: Low
**Status**: **Fixed** (Phase 6)
**Location**: `move/splash_core/sources/business_account.move`

`BusinessAccount` was created and transferred to the caller as an owned object. Owned objects are harder to query in dashboards (need to iterate by address) and don't compose with other shared-object flows.

**Fixed**: it is a shared object, and for a stronger reason than queryability. Phase 6 gave it plural `owners` and `approvers`, and an object several people must all touch cannot be owned by one of them. Because a shared object is nameable by anyone, no function infers authority from possession — every mutator checks the caller against the sets.

---

### L-05 · `receipt_v2` doesn't enforce caller is the actual settler
**Severity**: Low
**Status**: Open
**Location**: `move/sources/receipt_v2.move:26-53`

Anyone can call `create_receipt` with any data — there's no link back to a real `PaymentSettled` event or a `SettlementPool` reference. Off-chain readers cannot distinguish a real receipt from a forged one without cross-referencing the `tx_digest` to actual chain history.

**Recommendation**: Require either `AdminCap` OR a reference to the settlement pool whose event the receipt is supposed to attest to. Best: emit receipts as part of `settle_payment` rather than as a separate user-facing entry.

---

### L-06 · `peg_monitor::update_peg` lacks monotonic timestamp check
**Severity**: Low
**Status**: Open
**Location**: `move/sources/peg_monitor.move:59-79`

The function blindly overwrites `last_update_ms` with the current clock. If two PTBs race and the slower one lands second, the chain "remembers" the older timestamp as the latest — which is benign (still fresh) but technically not monotonic. More importantly, an admin replay attack could set the timestamp to an older value... actually no, it always reads from the `Clock`, so this is safe. Mark as informational.

**Recommendation**: Add `assert!(now > state.last_update_ms, E_TIMESTAMP_REGRESSION)` for defense in depth and to catch clock bugs early.

---

### I-01 · Inconsistent `AdminCap` parameter naming
**Severity**: Informational
**Status**: Open
**Location**: cross-module

- `peg_monitor::update_peg` — `_admin: &AdminCap` ✓
- `business_account::verify_business` — `_: &AdminCap`
- `dual_treasury::*` — `cap: &AdminCap` + `let _ = cap;`

Pick one convention (`_admin: &AdminCap` recommended).

---

### I-02 · Mixed module declaration styles
**Severity**: Informational
**Status**: Open
**Location**: cross-module

`settlement`, `business_account`, `peg_monitor`, `dual_treasury` use the short-form `module name;` (newer Move syntax). `smart_treasury`, `payment_intent`, `audit_anchor`, `receipt_v2` use the block form `module name { ... }`. This is a strong signal that the latter four are older or were copy-pasted from scaffold templates — they correlate exactly with the modules carrying the most critical findings.

**Recommendation**: Migrate scaffold modules to short-form once they're properly rewritten.

---

### I-03 · Scaffold vs production status not visible at module level
**Severity**: Informational
**Status**: Open
**Location**: `smart_treasury`, `payment_intent`, `audit_anchor`, `receipt_v2`

These four modules have doc-comments saying "Phase 1 scaffold" but nothing prevents them from being published. There is no compile-time guard preventing accidental mainnet deployment.

**Recommendation**: Add a `#[test_only]` guard until they're hardened, or split them into a `scaffolds/` subdirectory excluded from the production package via `Move.toml`.

---

### I-04 · `peg_monitor::update_peg` doesn't return new state
**Severity**: Informational
**Status**: Open
**Location**: `move/sources/peg_monitor.move:59-79`

Caller has to read `state` afterwards or parse the emitted event. Minor UX friction for PTB authors.

---

## Permanent Monitoring Checklist

These are the items the security/ops team should **always** keep eyes on. Each has a recommended cadence and alert threshold.

**v2 note (Amendment A1, 24 Oct 2026):** the rows that name `E_FEE_EXCEEDED`, `fee_bps`, `MAX_FEE_BPS`, `protocol_fees` or `lib/fx/corridors.ts` as the fee's source (1, 5, 7, 9, 15, 22, 25) describe the retired custody path. On v2 the fee comes from `FeeConfig` and its signals are its events: `FeeCharged` for revenue reconciliation, and `FeeScheduleProposed`, `FeeRecipientProposed`, their `…Applied` and `…ProposalCancelled` events and `FeeDiscountSet` for governance changes (alerting on them is Phase 2). Aborts 435, 1031 and 1033 mean a schedule rose after a quote was shown; 1032 should never fire.

### Hot signals (alert immediately)

| # | Signal | Source | Action |
|---|--------|--------|--------|
| 1 | `E_FEE_EXCEEDED` (code 103) appears in any abort | Sui RPC effects | Quote engine drift — investigate `lib/fx/corridors.ts` vs `MAX_FEE_BPS` |
| 2 | `E_PEG_BROKEN_USDC` or `E_PEG_BROKEN_USDT` (300/301) fires more than 1× per hour | Sui RPC effects | Stablecoin issue OR Pyth feed corruption — page on-call |
| 3 | `E_PEG_STALE` (302) for > 5 minutes | Off-chain peg daemon log | Peg daemon down — restart, verify SPLASH_ANCHOR_CAP_ID |
| 4 | Any `AdminCap` transfer to an address other than the canonical admin wallet | Sui events filter | Capability theft — rotate immediately |
| 5 | `PaymentSettled.fee_bps` > 150 | Indexer | Off-chain config wrong; advertised rates broken |
| 6 | New `BusinessAccount` objects created at > 10/min | Indexer | Spam / DoS — engage rate limit ASAP |
| 7 | `protocol_fees` balance grows faster than expected | RPC query | Possible fee_bps misconfig OR settlement loop |

### Weekly review

| # | Signal | Action |
|---|--------|--------|
| 8 | `dual_treasury::usdt_age_ms()` for any active buffer > 25 minutes | Investigate why sweep didn't fire |
| 9 | Total `protocol_fees` accrued vs. expected (revenue reconciliation) | Compare against off-chain quote totals |
| 10 | Number of `BusinessVerified` events vs. Sumsub completion rate | Drift = stale verification queue |
| 11 | `PegUpdated.sequence` monotonicity | Gaps suggest dropped operator updates |
| 12 | Settlements aborted vs. settlements succeeded | Trend up = config drift somewhere |

### Quarterly review

| # | Item | Action |
|---|------|--------|
| 13 | AdminCap key rotation — physical custody audit | Confirm hardware wallet, backup MPC shards, signer policy |
| 14 | Re-audit any module that changed since last quarter | Run this report's checklist against diffed code |
| 15 | Re-evaluate `MAX_FEE_BPS` vs. live corridor distribution | Tighten if no corridors are using the headroom |
| 16 | Dependency audit (Sui framework, Pyth, Sumsub, Walrus) | Read changelogs, regression-test |
| 17 | Disaster-recovery drill — simulate Pyth outage, AdminCap loss, peg break | Verify runbooks still work |

### Pre-deploy gate (before any Move upgrade)

| # | Gate | Pass criteria |
|---|------|---------------|
| 18 | Run `sui move test` with full coverage | 100% pass |
| 19 | Run `sui move build` in CI with `--lint` flag | Zero lint warnings |
| 20 | Diff abort codes against `lib/server/sui-settlement.ts::ABORT_CODES` | Every new code added |
| 21 | Re-run this audit checklist on changed modules | Findings ≤ Medium |
| 22 | Bump `MAX_FEE_BPS` only if corridor adds genuinely require it | Justify in PR description |
| 23 | Confirm scaffold modules are not in published package | `Move.toml` excludes them |
| 24 | Confirm peg state initializer aborts until first real update (post-H-05 fix) | Test added |

### Off-chain dependencies — keep these auditable

| # | Dependency | Why it matters | Where to look |
|---|------------|----------------|---------------|
| 25 | `lib/fx/corridors.ts` | Single source of truth for `fee_bps` | Code review on every PR; alert if `feeBps` mutated |
| 26 | `lib/server/peg.ts` (DeepBook V3 indexer) | The off-chain peg gate on payouts; no reading pauses them | `/api/quotes/peg-status` answers `primary: "deepbook"`. `update_peg` has no dollar source since Pyth needs a paid key, so it is not pushed (`lib/server/peg-attestation.ts`) |
| 27 | `SPLASH_ANCHOR_CAP_ID` env | Required for peg updates and audit anchoring | Vault / secret-manager audit trail |
| 28 | `lib/server/sumsub.ts` | KYB verification feed | Sumsub webhook signature verified |
| 29 | `lib/server/walrus.ts` | Audit anchor backing store | Walrus retention policy = 7 yr, blob count monotonic |
| 30 | Sponsor wallet (operator gas) | Settlement won't fire without gas | Balance monitor, refill threshold |

---

## Closing notes

**Highest-leverage next moves**, in priority order:

1. **Fix C-01, C-02, C-03 before any further work on those modules.** They are scaffolds and won't survive a real audit; pretending otherwise is worse than removing them from the package.
2. **Address H-05** (`init_peg_state` opens a 60s settlement window with zero peg data). One-line fix.
3. **Document AdminCap custody policy** (M-06). If the admin key is on a laptop somewhere, the entire protocol is one phishing email from being unrecoverable.
4. **Wire the abort code 103** into `ABORT_CODES` mapping — already done in this revision. Same pattern for any new abort codes scaffold modules add.
5. **Treat the four scaffold modules as deleted for production purposes** until rewritten. Move them under `move/sources/scaffolds/` and exclude from `Move.toml::[package].sources` until ready.

This report should be re-run after any change to `move/sources/` and committed alongside the change.
