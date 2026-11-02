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

## v2 Phase 2 carried items — fee alerts, near-threshold alerts, subscription billing — 2026-10-25

Designs: `docs/v2/fees.md` (Phase 2 list), `docs/v2/phase2-spending-rules.md`
("Near-threshold alerts"), `docs/v2/phase2-subscription-billing.md`. Tests:
`tests/fee-governance-alerts.test.mjs`, `tests/near-threshold-alerts.test.mjs`,
`tests/subscription-billing.test.mjs`. Migrations 0050 to 0054.

- **Fee proposals alert every owner.** The governance cron reads the
  canonical `FeeConfig` by state (pending schedules, pending recipient), type
  checked against core's original package and shared; see the v2 Phase 1
  section below. `SPLASH_FEE_CONFIG_ID` is required. A withdrawn proposal is
  told to every owner too (migration 0054). A fee config that cannot be
  trusted no longer silences the upgrade and owner-change alerts: those are
  still delivered from the wrapper and the config, nothing from the fee
  config is used or stored, the refusal is paged and the cron answers 502.
- **Near-threshold alerts are detective only.** They block nothing: a staff
  member can build a payment alone. Each business's rules are read with its
  own context; an alert is recorded and emailed per business, to that
  business's owners only, once (claimed before sending). The owners' route
  reads the session's org only.
- **Subscription billing is off** (`FEATURE_SUBSCRIPTION_BILLING`). While
  off, every billing route and the cron answer 404 before reading a session
  or the database; only a live or pending plan can still be cancelled. No payment path
  imports billing (a test walks `lib/`, `app/` and `components/`).
- **The wallet reader gained one plain-allowance shape, gated.**
  `allowance::new` is understood only when the server sets
  `expect.billing`: USDC, named `splash-billing:…`, to exactly the finance
  multisig, with an end of term and a calendar-month limit; a billing revoke
  only for an allowance the server read as this wallet's. The `subscription`
  purpose requires the bytes to carry exactly the plan's price, term, name and
  lifetime cap. Without `expect.billing` it is refused as before, and the
  spending-rule purposes never accept it.
- **Who can draw.** The finance multisig only, and only while it is
  `FeeConfig`'s fee recipient on chain (proven a multisig no single key signs
  for); never the operator. At most the plan price per civil month (the
  chain's `monthly_rate_limit`), and at most one pull per business per
  calendar month (UTC) by a unique index. The pull is signed by the finance
  multisig's members; the server builds, describes and stores the exact
  bytes, and never signs them. The AllowanceCap stays with the business
  wallet; revoking it stops billing at once.
- **Residual.** A finance multisig quorum could sign a pull Splash did not
  build; the chain still caps it at the plan price per monthly window under
  that allowance, and only until the wallet revokes it.
- **Review fixes (carried-items review).**
  - *Untracked allowances (High).* A subscribe whose follow-up missed the new
    allowance (indexer lag, swallowed error) stayed pending, and a second
    subscribe opened a signing request before the insert refused it: owners
    could grant a second billing allowance Splash did not track and could not
    revoke through Splash. The pending row is now written before the request
    opens; an executed but unrecorded subscribe is reconciled by the next plan
    request (which opens nothing until it is, `reconcile_pending`) and by
    every billing cron run (a 502 until it is); a subscribe or change revokes
    every billing allowance the wallet holds in the same transaction; and the
    cron reports any billing allowance no subscription tracks.
  - *Cancel needed the finance proof (High).* Cancel is now built from the
    stored subscriptions and what the wallet holds, never from
    `SPLASH_FINANCE_ADDRESS` or `FeeConfig`, and revokes every billing
    allowance the wallet holds to any finance multisig the business
    subscribed to. The `subscription` purpose requires the transaction to
    revoke exactly the allowances the server named, no fewer and no other.
  - *Wrong plan on a retried pull (Medium).* A failed or unsigned pull of a
    replaced plan is `superseded` (invoice void) and the month is billed
    under the plan in force on a new row; the unique index is partial
    (migration 0053), so a month is still drawn at most once. A plan change
    supersedes the old plan's unsigned pulls at once, and a pull of a plan no
    longer live notices nobody.
  - *Stuck pulls (Medium).* A pull unsigned past its gas window is rebuilt on
    the same row; one sent but never seen once its window has passed is made
    signable again; a submission the network refuses before running it
    leaves the pull signable (`not_sent`). The same bytes twice are one
    transaction, so nothing is drawn twice.
  - *Invoice numbers (Low)* are a per-month sequence, not a 32-bit hash of
    the org, so two businesses cannot block each other's billing.
  - *Calendar month (Low, residual).* The chain's `monthly_rate_limit`
    windows are anchored on the first charge (`sui::allowance` `anchor_ms`),
    not on the 1st; "per calendar month (UTC)" in A1's Settings line is
    enforced by Splash's partial unique index. A finance quorum signing
    outside Splash could draw the price twice in one calendar month (once in
    each of two windows), and a plan change starts a fresh window. Both are
    bounded by the plan price per window and end when the wallet revokes.

## v2 Phase 2 §4.8 — Zeke's rules — 2026-10-25

Design: `docs/v2/phase2-zeke.md`. Tests: `tests/zeke-rules.test.mjs`.
Migration 0049.

- **D-0004 traced.** Every tool the model is offered is a READ or a draft;
  the test checks the registry, the implementations and that no agent module
  imports a signer, keypair, KMS client or approval call.
- **The limitation statement is code, not prompt.** A deterministic intent
  classifier states the limit before every money-moving turn acts, and before
  any money tool the model calls on a turn the classifier did not foresee; a
  read-only turn hears it once per sign-in session.
- **Once per session is a primary key** on `zeke_session_notices` (org,
  session hash, notice), keyed on a hash of the verified session; production
  without a database fails closed (limit stated, nudge skipped).
- **Cross-tenant reads closed (Medium).** `getInvoice` and `getCounterparty`
  took only an id, so a model told by an invoice to read or pay another
  tenant's record could; and the batch and netting drafts accepted any
  counterparty id, verified or not. Both now take the session org (another
  tenant's record is "not found"), and every draft names only this org's
  verified, clear counterparties. The seeded sample workspace stays visible
  to all, DEMO-labelled.
- **The chat route** resolves the org through `requireSessionAccount`, so a
  signed-in person with no membership gets an answer, not a 500.
- **The model client test hook** refuses to be set in production.
- **Review fixes (§4.8 review).**
  - *Classifier gaps (Medium).* Indirect and polite phrasings ("kindly pay",
    "we need to pay", "is it possible to pay"), act-on verbs (approve,
    release, execute, process, fund, repeat, resend a payment, payout, batch
    or payroll), refund, reimburse, disburse, cash out, off-ramp, buy,
    rebalance, quoted asks and a money clause after a question are now
    money-moving. On the model path each response's text is held back until
    its tool calls are checked, so the statement precedes the model's own
    "Done, queued" text.
  - *Forged history (Medium).* The route and the tool loop pass the model
    only `{role: user|assistant, content: string}` turns, each capped
    (`sanitizeOxwalHistory`); a forged `tool_result` or system turn is
    dropped. With a session key the ledger alone decides once-per-session
    notices, so a forged assistant turn cannot suppress the read statement.
  - *Sample counterparty payable by every tenant (Medium).* Drafts (payment,
    batch, netting) now require the counterparty's own org to be the session
    org. The sample workspace stays readable to all as an example but only
    the sample workspace can draft against it.
  - *Low.* A report or summary request is a read; a refused turn or a USDC
    send that prepares nothing no longer opens with "I can prepare this
    payment". The session key is an HMAC under `CUSTOMER_SESSION_SECRET`,
    not a bare hash; expired rows are pruned on about 2% of claims.

## v2 Phase 2 §4.7 — wallet recipients: exchange accounts, proven wallets, CCTP — 2026-10-25

Design: `docs/v2/phase2-wallet-recipients.md`. Tests:
`tests/wallet-recipients-v2.test.mjs`, with additions to
`tests/compliance-payment-gates.test.mjs`, `tests/controls-evidence.test.mjs`
and `tests/spend-rules.test.mjs`. Migration 0047.

- **No payment to a wallet the supplier holds before it proves it holds it
  (D5b).** A signed Sui personal message over a fixed text naming the
  address, the supplier, the paying business, a 32-byte nonce and a 72-hour
  expiry. The link's token is kept only as its SHA-256; the challenge is
  used up before the signature is checked (one try per link, each nonce
  once for ever); a newer link replaces an open one; the proof is recorded
  only if the recipient's address is still the one the link was made for.
  The proof is also the WALLET tag's gate on a SpendPolicy, and withdrawing
  it (owners, or removing the recipient) cancels a waiting request that
  would tag it.
- **The payment gate** (`walletDeliveryGate`), when a wallet payment, an
  owners' payment of an open intent or a second approval is opened, and
  before every signature: kind WALLET only to this business's proven
  wallet, kind EXCHANGE only to its saved exchange account; an address
  saved as the other kind is refused, so the declared kind cannot dodge the
  proof or the Travel Rule. Previously any CLEAR address could be paid as
  either kind (Medium: D5b was not enforced off chain). The older
  per-person send lane refuses an unproven wallet and any exchange account
  at its quote.
- **The EXCHANGE tag** on a SpendPolicy only for a saved exchange account of
  this business (previously any address could be tagged EXCHANGE without a
  proof, which skipped D5b for rule payments: Medium).
- **The exchange of a Travel Rule message and a sender declaration** is the
  saved recipient's, not the request's (§4.6 open item closed).
- **Recipients are screened before they are saved**, a BLOCK never saved;
  one address is one recipient per business; the org is the session's,
  owners and staff only; another business's recipient, proof or receipt
  reads as absent.
- **Cross-chain (D5c, D13):** USDC only, CCTP V2 only, the owners' multisig
  only (Move, the rule path and staff asks all refuse kind 3). The receipt
  records the burn only from this business's own executed multisig request
  that confirmed the intent on chain; Circle's attestation only for a
  message that mints exactly this payment (domain, mint recipient, amount,
  fee bound, any relayer); the mint only from the destination chain's
  receipt of Circle's `MessageReceived` for that nonce. Forward only, by a
  trigger; production reads only the configured Circle service and never
  its sandbox.
- **Open:** the cross-chain PTB and bridge adapter; reading a Solana mint;
  the supplier's proof page (Phase 3); a legacy wallet recipient (saved
  before 0047) is unproven and unpayable until proven, which Phase 3 must
  explain to the business; Phantom is not offered as a label although D5
  names it (it ended Sui support; the table refuses it since 0020).

### §4.7 review follow-up — 2026-10-25

Tests: `tests/wallet-recipients-v2-controls.test.mjs`,
`tests/cross-chain-sweep.test.mjs`, with additions to
`tests/compliance-payment-gates.test.mjs`, `tests/controls-evidence.test.mjs`
and `tests/stablecoin-send.test.mjs`. Migration 0048.

- **An exchange account was taken on the business's word (High).** Any
  address saved as EXCHANGE could be paid once its Travel Rule message was
  merely `submitted`, so choosing the exchange kind avoided D5(b). Now an
  exchange account is unconfirmed until a Travel Rule message to that
  address at that exchange, made after it was saved, is `approved` by the
  counterparty (never a sandbox one in production): until then its first
  payment may be opened but not signed (`exchange_unconfirmed`), and the
  EXCHANGE tag is refused.
- **Splash-controlled addresses could be recipients (High, B1).** The
  operator (the gas sponsor), treasury, test recipient, FeeConfig's fee and
  pending recipient (read live), and the operator's CCTP deposit addresses
  are refused at saving and at every gate (`splash_controlled_address`);
  production refuses when it cannot name them.
- **A late signature check undid an owner's withdrawal (Medium).** The proof
  is now recorded in one transaction, only if the recipient's ownership
  epoch is the link's; every withdrawal moves it on (`proof_withdrawn`).
- **The older WALLET body skipped the supplier's details and the role check
  (Medium).** It is now the same save, owners and staff only, and the gate
  refuses a wallet without the supplier's details
  (`supplier_details_missing`).
- **EIP-55 was skipped for lower-case addresses (Medium).** A cross-chain EVM
  address is taken only in its checksummed form.
- **A Solana mint recipient was the business's word (Medium).** The chain is
  asked: an SPL Token account for Circle's USDC mint, initialized; its owner
  recorded. No RPC, no save.
- **An insider could prove their own wallet as a supplier (Medium).** The
  business's wallet and its members' addresses are refused (`own_address`);
  a recipient a staff member saved is paid or tagged only once an owner
  approves it (maker-checker); the proof link goes to the supplier's email
  and only an owner is shown it; who saved, approved and proved each
  recipient is in the controls evidence.
- **Low:** removing a payable wallet is owners only, and removing any
  recipient owners and staff only; one EVM transaction may carry several
  payments' mints; two saves of one address cannot race past
  one-address-one-recipient (a per-address transaction lock); the send lane
  re-checks the recipient at submission; a sweep asks Circle again for
  every burned payment and reports one not minted six hours on.
- **Residual:** an exchange's `approved` is Sumsub's report of the
  counterparty's answer, not a test deposit; whether each exchange uses
  per-customer deposit addresses or a memo is to be confirmed before
  go-live. A rule payment by a staff member now has a server path
  (`staff_rule_payment`), and the signing layer runs this gate before each
  signature on it (an exchange account is not paid under a rule).

## v2 Phase 2 §4.6 — compliance: KYB, Travel Rule, KYT, controls evidence — 2026-10-25

Design: `docs/v2/phase2-compliance.md`. Tests:
`tests/compliance-kyt.test.mjs`, `tests/compliance-sumsub.test.mjs`,
`tests/controls-evidence.test.mjs`, `tests/compliance-payment-gates.test.mjs`.

- **Fail closed.** KYB, Travel Rule and KYT each have a labelled sandbox
  outside production only. In production, decided by the runtime mode
  alone, KYB and the Travel Rule refuse without Sumsub (503) and KYT
  answers no verdict; nothing downstream ever sees a made-up session,
  verdict or reference.
- **Fixed before this section (High):** `POST /api/kyb/sumsub` took the case
  id, business name and registration number from the request, did not
  scope the case to the caller's business, and attached the provider's
  applicant to any case by id. It now reads the case by the session's org
  and sends the case's own details. It also created applicants under the
  case id while the webhook only accepts `org:<orgId>`, so no verdict could
  reach its business; the applicant is now `org:<orgId>`.
- **The webhook** verifies the HMAC before reading, in the algorithm Sumsub
  names (an unknown one is refused), inside a two-day window, and applies
  each delivery once (`webhook_events`, keyed by the body's SHA-256). Only
  `externalUserId` names the org. PROVIDER cannot reach ACTIVE; a refused
  transition is acknowledged and nothing moves back. A RED the applicant may
  retry no longer rejects. Travel Rule statuses move forward only, for
  their own reference, txnId and business.
- **Travel Rule** messages go once per payment (unique per business and
  payment; Sumsub's txnId is the payment), only to a recipient whose newest
  screening by this business is CLEAR, with everything read on the server.
- **KYT.** Elliptic's wallet exposure decides by its risk score (a null
  score is REVIEW); the sanctions list only makes it stricter. Addresses are
  checked per chain before screening. Every screening is kept append-only
  (0045), a verdict needs the provider's reference, and another business's
  screening does not count. Only CLEAR permits a payment.
- **Controls evidence** per payment, JSON and PDF, for this business only
  (another's reads as 404). It carries masked data only and is checked for
  secret, signature, sealed, salt and account-number fields before it is
  served.
- **Review fixes (p2-4.6).** High: the screening was kept but nothing in
  the money path read it, so a BLOCK or unscreened address could be paid.
  Now a wallet payment, the owners' payment of an open intent and an
  owner's second approval are opened only for a fresh CLEAR (BLOCK 403;
  REVIEW, unscreened or no answer 409; a CLEAR older than 24 hours is
  screened again or refused), and the check runs again before every
  signature. High: an exchange payment could be signed and sent with no
  Travel Rule message, or after Sumsub rejected it. Now it is not signed
  until the message is with the provider; on hold holds, rejected refuses;
  an address screened as an exchange's counts as one whatever kind the
  payment names. Medium: a database failure while applying a KYB verdict
  was acknowledged as a refused transition and the verdict lost; only
  `KybTransitionError` is acknowledged now, anything else releases the
  delivery. Medium: one provider reference covering two addresses returned
  the first address's screening for the second; the key is per address
  (0046) and the sanctions list's reference names the address. Medium: the
  evidence listed today's screenings and KYB case as if they applied at
  payment time; it now splits screenings at the approving signature, and
  says when no CLEAR came before, when the KYB case changed after, and when
  an exchange payment has no Travel Rule message. Medium: two callers could
  both send a Travel Rule message and a lost answer left it stuck; a
  compare-and-set claims the send, a duplicate is held `unconfirmed` until
  Sumsub's webhook names it, two saved recipients at one address are
  refused, and one deposit address keeps one exchange. Low: the originator
  is the KYB case's name and number and needs an approved KYB; the evidence
  refuses account-shaped values and more account keys, and copies partner
  fee lines field by field; production refuses SHA-1 webhooks unless
  `SUMSUB_WEBHOOK_ALLOW_SHA1`; only an owner opens a KYB session.
- **Second pass (p2-4.6, 26 Oct).** Medium: a screening or Travel Rule
  message the sandbox wrote was taken as the provider's in production when
  it was already on file (a non-production server writing to the same
  database): a sandbox CLEAR opened and signed a payment, sent a Travel Rule
  message, and cleared a held deposit once its source was proven; a sandbox
  Travel Rule message let an exchange payment be signed. Now a verdict
  counts only with the provider's reference and time and never the
  sandbox's in production (`isProviderAnswer`): the address is screened
  again or the payment refused, the deposit stays held, and production keeps
  no sandbox verdict; a sandbox BLOCK still blocks. Medium: a cross-chain
  payment's CCTP receipt was opened without reading the destination
  address's screening. It now needs this business's fresh CLEAR of that
  address on its own chain (`crossChainRecipientGate`). Low: the evidence of
  a cross-chain payment lists the destination address's screenings and
  names a missing CLEAR before approval; in production it names a sandbox
  screening or Travel Rule message as not the provider's. Test:
  `tests/compliance-provider-answers.test.mjs`.
- **Third pass (p2-4.6 review, 26 Oct).** High: a Solana cross-chain
  recipient was screened by its USDC token account only, never by the
  wallet that owns it (read on chain and kept as `destination_token_owner`,
  but never screened). Sanctions and KYT lists name wallets, so the token
  account of a listed wallet screened CLEAR, was saved, and passed the
  cross-chain gate; CCTP would then mint to it, which cannot be undone. Now
  the owner wallet is screened on save and when the payment is opened
  (`crossChainDestinationGate`): both must be fresh CLEARs, a BLOCK on
  either decides, and a Solana recipient with no owner on file is not paid.
  The evidence lists the owner's screenings (`cross_chain_recipient_owner`)
  and names a missing CLEAR. Medium: in production, a sandbox Travel Rule
  message on file held the payment with "send it through the provider",
  but that send was refused (`travel_rule_conflict`) and the payment could
  never be signed. A send through the live provider now replaces the
  sandbox row in one compare-and-set, under a new id so the sandbox's late
  answer cannot land on it. Low: a retry of an opened cross-chain receipt
  is screened again (the receipt is kept, the refusal reported); the
  deposit and recipient handling of a sandbox BLOCK is written down; and
  the production-only sandbox rule rests on `NODE_ENV` alone, now a line on
  the mainnet checklist (docs/v2/phase2-business-wallet.md, Mainnet). Open:
  the cross-chain signing check (still to be built; it must call
  `crossChainDestinationGate`); nothing in code detects a non-production
  process on the production database.
- **Open:** supplier name screening (the recipient screening on save and
  the exchange taken from the recipient record are closed by §4.7, above);
  a staff member's own in-limit rule payment
  (now built, and screened before it is opened and before each signature; a staff
  member who builds a payment alone, without Splash's backend, is still not
  screened by Splash); an owner override of a
  Travel Rule hold (not built: compliance to decide); checking Elliptic's and Sumsub's shapes against
  the contracted sandboxes; who is the originating party for Travel Rule
  purposes when the sender is the business's own self-hosted wallet
  (counsel).

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
- **A failed payout's USDC is asked back until the partner accepts.** Each
  ask is counted on the row and the acceptance time kept (0044); the sweep
  asks again every run while it is owed and alerts ops once after five
  asks. A signed event Splash does not know is acknowledged, changes
  nothing, and is kept (id, type, status, cut short; no body) in
  `payout_partner_unknown_events` with an ALERT on its first delivery.
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
  the chain shows it sent by the deposit address into the wallet, in a
  later checkpoint than the payout's own deposit. Every return digest,
  short or whole, is claimed once in `withdrawal_returns` (primary key) for
  one withdrawal or supplier payout; the returned amount is the sum of its
  claims, it closes the payout only when the sum is exactly the amount
  sent, and a return that would pass the amount is refused for ops
  (`return_over`). A short sum is held failed for review, and the partner
  is asked for the rest. A return with no failure reported first (the
  partner did not pay out) is taken the same way, from sent or partner
  received.
- **Own account only.** A destination is stored only when the name given
  and the bank's own holder name (the partner's name enquiry) both match
  the registered legal name, and that name counts only once KYB verified it
  (kyb_status basic or full). Only an owner may set it, and it is fixed once
  KYB is under way; a change before that revokes every bank account and
  cancels withdrawals not yet sent. The trading name is not accepted.
  Names fold case, punctuation, Latin accents and legal suffixes only;
  letters of other scripts are compared, not dropped. The
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
  by `max_fee`. A quote whose partner fees leave the bank nothing
  (`below_partner_fees`) and an accepted receive amount of 0
  (`nothing_received`) are refused before anything is stored or instructed.
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
- **Open:** the live Hata and Fiuu APIs and their webhook payloads; no
  reconciliation of `paid_out` against bank evidence yet. (The sweep,
  `/api/cron/withdrawals`, posts unposted digests; reads never do. Key
  rotation is through `WITHDRAWAL_ACCOUNT_KEY_PREVIOUS`.)

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
| F-11 | High | (Second pass.) USDC beside a Circle mint that credits nobody (two mints, an unreadable body, another recipient) was attributed to the transaction sender alone, so the business's own proven wallet relaying two mints cleared them with neither burner screened. **Fixed**: that USDC is held as `mint_unattributable`, whoever sent it, and a recheck keeps the hold. | Fixed |
| F-12 | High | (Second pass.) A watcher run that stopped at its page limit left the balance minus recorded holds spendable, although transactions beyond the pages read were unscreened (an arrival and a later outflow cancel out in the net). **Fixed**: until a run reaches the newest transaction, `walletFundsWithheld` withholds the whole balance; the next run reads on. | Fixed |

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
- **Fee proposals reach every owner (Phase 2).** The governance alert cron
  also reads the canonical `FeeConfig` (`SPLASH_FEE_CONFIG_ID`, typed
  `<core original>::fee_config::FeeConfig`, shared), by its state, not the
  event feed: each pending schedule slot (`FeeScheduleProposed`) and the
  pending fee recipient (`FeeRecipientProposed`) is an alert to every owner
  in the app, by email and on a verified WhatsApp number, with the proposed
  schedule against the one in force, or the new recipient; a schedule or
  recipient that took effect is told against the stored state. A withdrawn
  or lapsed proposal stops being shown; the withdrawal itself is not a
  separate message. A `FeeConfig` that is missing, of another type or not
  shared answers 502 and pages a person. Discounts (`set_discount`) only
  lower a fee and are not alerted. Without `SPLASH_FEE_CONFIG_ID` the cron
  does not run at all.
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
  spenders, each under the threshold, which the Phase 2 near-threshold
  alert flags to the owners (detective only: `lib/server/near-threshold.ts`,
  `/api/cron/spend-rule-alerts`, which also flags one spender paying one
  recipient repeatedly at 80% or more of the threshold); and, with a fixed window, the
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

## v2 Phase 3 — Team, the Finance lead, and who may Add funds and Withdraw — 2026-10-31

The business's owners run their team, not Splash support
(`docs/v2/phase3-team-roles.md`). What the code holds to:

- **Default deny, one place.** Adding, changing and removing people, the
  Finance lead and Add funds / Withdraw access are decided in
  `lib/server/team-admin.ts` only. A caller who is not an owner or the
  Finance lead is refused on every function before anything is read. The
  routes (`app/api/team/**`) share one gate (`lib/server/team-route.ts`): the
  business and the actor are the session's, never a field of the request, and
  `tests/team-routes.test.mjs` fails if any other file calls a team-changing
  function. Changes are rate limited per person and per business.
- **The Finance lead is not a role.** It is an appointment on a membership (one
  open row per business, a partial unique index), valid only while the person is
  still an approver of the business. `memberships.role` gained no value, so every
  `role === 'admin'` check means owner and the lead fails each. The lead can add,
  change and remove viewers, staff and approvers; they cannot give the owner
  role, touch an owner, appoint or take back the role, change or remove
  themselves, grant or take away Add funds or Withdraw, or change anything on the
  wallet beyond starting a request to add a signer. That request is signed by
  the wallet's signers; the lead, who is not one, is refused `not_a_signer`. No
  Move code changed.
- **A business always has an owner.** Nobody changes or removes themselves; only
  another owner can. That alone is not enough when two owners act on each other
  at the same moment, so changing or removing a member runs in one transaction
  that first locks the business's owner rows, reads again, and refuses a change
  that would leave no owner (409 `last_owner`). Splash support's `revokeRole`
  takes the same lock and refuses to remove a business's only owner.
  `tests/team-roles-hardening.test.mjs` runs two owners demoting, removing and
  mixing against each other. The in-process test database serialises
  transactions, so the tests prove the rule and the rollback; it is the row
  lock (`SELECT ... FOR UPDATE` on the owner rows) that protects a deployment
  with several connections. A person who belongs to
  another business, has no account or has not verified their email cannot be
  added, and the answer is the same for all three, so the form tells no one who
  has an account. The owner chooses how to add someone: directly (no step on the
  person's side, so the owner confirms they have the right person and the route
  refuses without it) or by invitation, below.
- **Add funds and Withdraw are granted.** Owners have both; a staff member or
  approver only with an owner's grant, kind by kind; a viewer never. Read from
  the database on each request for the session's person and business, and a
  stale row for a viewer or a person who left grants nothing. The old rule let
  any non-viewer add funds and any staff member ask for a withdrawal. A top-up's
  details are read only with Add funds; the funding options and the deposit
  history are the wallet's record and are shown to every member who can read
  the wallet. Sending USDC to the wallet from any wallet is unchanged and still
  screened and held.
- **What ends with a person.** A removal ends their place in charge, the
  Finance lead role, their access grants and usable sign-offs, writes a
  `member_offboarded` line, and records their passkey addresses so a spending
  rule they hold shows as orphaned. A move to viewer or owner ends the same
  holds but is a role change: no offboarding line and no orphaned-spender row,
  because the person is still here and their rule already reads as a viewer's
  (or an owner's) until the owners' quorum changes it. A viewer who holds a
  passkey and a spending rule can still pay inside that rule on the chain; the
  dialog and the Finance lead words say so. The Finance lead cannot end any of
  that by moving or removing the person who holds it: someone in charge or
  holding Add funds or Withdraw is an owner's to move. The change and its
  clean-up commit together or not at all. Removing someone from the team does
  not remove an owner from the multisig; a change of signers, signed by the
  quorum, does.
- **The trail.** Every grant, change and removal is a line in the append-only
  `wallet_authority_events` (seven new actions, migration 0066), with the actor,
  the person and the old and new role. Splash support's grant is a line under
  `operator:<email>`. A retry writes nothing; two at once make one change.
- **Invitations (1 Nov).** An owner, or the Finance lead for a role below owner,
  invites an email; the person sees it after signing in and accepts or
  declines, it ends 7 days after it was sent (to the millisecond), and its
  sender can withdraw it. **There is no token, link or code**: the signed-in
  account's own verified email finds the invitation, so there is nothing to put
  in a URL or log or to replay (`team_invitations` has no such column, and a
  test fails if the invitation code reads a token or a query string). The id is
  random and grants nothing: for anyone else it reads as "not found". An
  unverified account is shown nothing. Any email may be invited and the sender
  hears the same whatever the address is, so inviting reveals no account or
  business; a person already on a business is told plainly, naming none, and
  can only decline. Accepting twice, declining twice and sending twice change
  nothing and write one line; two businesses accepting at once leave one
  membership. An invitation whose sender no longer manages the team is closed
  on the trail, not honoured. The trail keeps a masked address only, because a
  line can never be deleted. Routes: the business and sender are the session's
  (`teamRoute`), the answering routes use a gate that needs a signed-in account
  and nothing else (`inviteeRoute`, refusing with no database), every change is
  rate limited, and `tests/team-routes.test.mjs` fails if anything else calls
  the new functions.
- **The invitation email (2 Nov; Sky's decision of 1 Nov).** The invited person
  is also emailed, through Resend (`lib/server/invitation-email.ts`, migration
  0082). What it does: tells a named person that a named inviter asked them to
  join a named business, that it is open for 7 days, and links to one page. What
  it does NOT do: it carries no token and grants nothing. The link is the app
  address plus the invitation's id; opening it requires sign-in, shows the
  invitation only to the account whose verified email it was sent to (anyone
  else, and an unknown id, read the same "not found"), and accepts nothing; Accept
  is a button. A forwarded or over-the-shoulder email therefore cannot be used to
  join. It holds no amount, no other business and no other person, escapes every
  inserted value (a name cannot add a header line or markup), and has no image,
  so no tracking pixel. The send is claimed with one UPDATE on the invitation,
  so a retry, a double click or two owners send once, and the provider gets an
  idempotency key. A failed send never loses the invitation and is shown to the
  owner in plain words with an owner-only "Send the email again" (one send per
  click, never for a sent, ended or withdrawn invitation, other businesses'
  invitations read as absent). With no real sender set up, or no link production
  would allow, nothing is sent and the owner is told so in an alert; a console
  sender never counts as sent. Logs hold the invitation's id and the kind of
  failure, never the key, address or link. Splash sends this from its own
  address with an owner's own words in it, so the inviter's and the business's
  names are stripped of anything a mail client would link (web addresses, other
  schemes, bare domains, email addresses, numeric hosts, in look-alike forms too)
  and of invisible characters: the only link in the email is the invitation's.
  A send whose outcome is unknown (a timeout, a lost connection, a server error)
  stays "sending" and is retried with the same provider key, so it cannot become
  a second email. No per-sender invitation limit exists for now; it is to be
  revisited before launch. The only brakes left are 25 open invitations per
  business and the team-change limit (60 an hour per person, 200 per business);
  they do not stop an owner from inviting, withdrawing and inviting an address
  again, so this is an abuse path to weigh before launch. Test:
  `tests/invitation-email.test.mjs`.
- **Leaving (1 Nov).** Any member can ask to leave; nothing changes until an
  owner approves. Only an owner decides (review of 2 Nov: a Finance lead's
  approval ended access but could not take the spending rule back, so it left a
  live rule behind; the lead now sees requests and decides none). Nobody decides
  their own request, so an owner's leaving needs another owner, and the only
  owner cannot ask. Approving ends access, clears every hold and records the
  person's addresses in one transaction under the owner lock; then the route runs
  `runLeaveFollowUp`: it opens the existing spending-rules revoke
  (`revokeOrphanedRules`), which the wallet's owners sign on their own devices,
  reads whether the person is still one of the business wallet's signers
  (leaving the team does not remove a signer; a change of signers is a separate
  request the owners sign, and the answer and the approval dialog say so), and
  writes both outcomes as one trail line (`leave_follow_up`, migration 0075). A
  rule that outlives its holder also shows as orphaned on the wallet page and in
  Settings, so a lost follow-up cannot hide it. The code signs nothing. A
  declined request tells the person so in words on their own page for 14 days.
  Every step is a trail line (ten new actions, migrations 0073 and 0075).
- **One business per person (2 Nov review, High).** Two accepts, or an accept
  and an add, for one person at the same moment could each pass the "not on a
  business" check under READ COMMITTED and both commit, putting the person on two
  businesses (authority resolution picks one by row order). `memberships(user_id)`
  is now unique (migration 0074), and accepting or adding takes a per-person row
  lock first (`lockPerson`). PGlite serialises transactions, so the race itself
  is not reproduced in tests; the constraint, the lock order and the stale-read
  refusal are. Still to do once: a two-connection run on a real Postgres.

## v2 Phase 3 — Staff payments inside a rule — 2026-11-01

A staff member whose spending rule covers a payment pays it alone, signed by
their own passkey; anything outside the rule asks the owners
(`docs/v2/phase3-staff-in-rule.md`). Sky's rule: anyone can fund the wallet,
but they can only spend what the rule allows, and anything outside the rule
needs the person in charge. No Move changed. What the code holds to:

- **The rule is checked four times by four things.** The page, the server
  before it builds (the same function, over a fresh chain read: a stale page
  cannot claim a rule the chain does not show), the signing layer (the bytes
  must be exactly open, no second approval, pay under the stored allowance,
  anchor, delete; sent by the person the rule is for, to the stored payee, for
  the stored amount and fee bound, drawing exactly amount plus fee), and the
  chain (`splash_spend::pay_intent` and the allowance).
- **An allowance withdrawal has one legal use.** The decoder allows a
  `FundsWithdrawal` from an allowance only as the argument of
  `splash_spend::pay_intent`, only for the one allowance and funder the
  server read as that person's (`expect.staffPay`), and only for a request
  opened with that expectation. `redeem_funds`, a send, another allowance, or
  any other purpose refuses it.
- **No second approval can be smuggled in.** The approval slot is an empty
  `Option<PayoutApproval>` made in the same transaction and used once; a half
  built or reused one is refused.
- **No draw outside the rule.** Expired, not started, taken back, over the
  limit, cap used up, recipient not verified (or an exchange, or verified for
  another kind), over the threshold, another asset: each is a plain reason.
  `via: 'rule'` turns it into a refusal with nothing stored; otherwise the
  owners are asked.
- **Fail closed.** No chain client for spending rules, an unreadable chain, no
  gas sponsor, no policy, or a passkey that cannot sign here: nothing is built.
  There is no stand-in rule, signer or sponsor, in production or out of it.
- **Replay and races.** The intent id is unique per business; the payment
  reference is claimed once on chain, and an intent id answers only the person
  who made the payment (another member, owner or not, gets 409
  `idempotency_key_reused` and sees nothing of it). The claim and the read of
  what has already been asked for are one step under an advisory lock per
  business, so two sends cannot both claim the last of a cap or of a
  recipient's second-approval amount. Withdrawn, declined, expired and failed
  requests hold nothing; a claim still being made holds for 15 minutes (a slow
  bundle upload), then is let go of. The moment a rule is read is taken before
  the chain is read.
- **Staff cannot use up the owners' network-fee allowance (found by review,
  High).** A staff payment is a sponsored transaction opened before anyone
  signs it, and the business's 1 SUI per 24 hours counts every request. A
  person holds at most three payments waiting to be signed (`too_many_open`),
  and staff payments together may use 20% of the day's allowance
  (`WALLET_SPONSOR_STAFF_SHARE_PERCENT`; past that the owners are asked,
  `staff_gas_share_used`), so the owners always keep 80% for their own
  payments. Tested: 45 one-USDC payments no longer lock an owner out.
- **Funds on hold are never drawn**, and the recipient must be a fresh CLEAR
  and a wallet the supplier has proven, as for the owners' own payment; the
  signing layer checks both again before the signature.
- **Same-recipient splitting across spenders is blocked off chain and
  detected.** The chain checks the second-approval amount per payer and
  recipient, so several spenders could each stay under it. The server and the
  page count every spender's running total to that recipient, and every staff
  payment still on its way to it, together: the payment that would cross the
  amount goes to the owners (`above_threshold`). The near-threshold alerts
  still read these payments (`RuleSpend`, running totals). The Move-level
  recipient-wide total stays a decision for Sebastian's review (it needs a
  republish of `splash_spend`).
- **Open:** no testnet run of the PTB (`pay_intent` with an allowance
  withdrawal input and an empty `Option<PayoutApproval>`); a passkey's
  signature on a sponsored single-signer transaction is part of the owed
  hardware check; an exchange account is not paid under a rule.

## v2 Phase 3 — Batch payouts (brief 5.6) — 2026-10-31

Up to 20 payments in one Sui transaction the owners' multisig signs once
(`docs/v2/phase3-batch.md`). What the code holds to:

- **A sheet is untrusted data.** A row can only name a recipient this business
  already saved (or a Splash business by registered name); it can never add a
  payee, an address or a fee, and text in a cell is never an instruction. The
  server reviews the rows itself, at creation and again when the signatures are
  started; a recipient changed, removed or no longer cleared stops the batch.
- **The bytes are exactly the rows.** `assertPurposeShape('wallet_batch')` refuses
  a transaction that is not the stored rows' payments in order, each tied to its
  own withdrawal and intent, with the row's recipient, amount, kind and fee bound.
  Each owner's device decodes the bytes itself and checks them against the batch
  that was approved before the passkey is asked.
- **Every payee is checked before every signature** (`batchBeforeSign`): a fresh
  provider CLEAR (a sandbox verdict is no answer in production) and the saved
  recipient's own rule; an exchange, a bank or another chain is never in a batch.
- **The audit bundle fails closed** in production; no stand-in is anchored.
- **Idempotent** by the batch's intent id, unique per business; each row's
  payment reference is its own and unique per business; one key makes one batch
  and one request.
- **Tenant isolation** through the session's org on every route; another
  business's batch, recipient or receipt reads as absent.
- **Not carried out:** a scheduled batch (`splash_spend`, an executor named by an
  owner) answers `schedule_not_wired` and schedules nothing. A full 20-payment
  batch has not been dry-run against the protocol's per-transaction limits and the
  sponsor's gas budget; only the model chain ran it.

## v2 Phase 3 — Invoices: Get paid and Pay invoices (brief 5.8) — 2026-10-25

Design: [`docs/v2/phase3-invoices.md`](docs/v2/phase3-invoices.md). Tests:
`tests/pay-invoices.test.mjs`, `tests/invoices-page.test.mjs`,
`tests/pay-invoices-review.test.mjs` (the independent review's findings),
`tests/pay-invoices-review-paths.test.mjs` and
`tests/pay-invoices-review-two.test.mjs` (the second review's findings).

Second review (each pinned in `pay-invoices-review-two`):

- **Splash's own addresses fail closed.** The operator and treasury addresses
  are required; any configured address that is not a Sui address, a set but
  malformed `SPLASH_FEE_CONFIG_ID`, or an unreadable FeeConfig throws, and
  match and approve answer 503. The FeeConfig recipient proposed under the
  24h notice is Splash's too. Addresses are normalised, not filtered.
- **The hand-off key is versioned.** Invoice id, `payment_attempt` (0059) and
  a hash of recipient, amount, currency and date; the contract says the same
  key with another payload is a 409. Approve writes "approving" only onto
  the invoice it handed off, and otherwise asks the flow to drop the intent.
  "Approving" has a way out (`withdraw`), only through the flow's `cancel`.
- **Self-custody wallets need the ownership proof** (D5, 4.7) before match and
  hand-off (`ownership_unproven`). Nothing on this branch records the proof,
  so no wallet recipient is paid from Invoices until 4.7 lands. The 5.4
  contract asks the flow to check screening, the proof and Splash's
  addresses again when it builds and signs.
- **Names.** Only the same name needs no reason; generic words do not make
  two names alike.
- **Get paid.** The reference is given once, with "paid", kept as
  `received_reference`; never rewritten after. The PATCH is a guarded UPDATE
  on the status read (409 `changed`), closing the gap noted below. The pay
  link's report is bounded, kept in `payer_reported_name`/`_email`, never
  over the issuer's payer, and its email is not logged.

- **A supplier's invoice is untrusted data.** What it says is a proposal; a
  person confirms every field. The payee picks candidates among the
  business's own verified recipients only (screening `CLEAR` or admin
  `ATTESTED`); an account or wallet printed on the invoice is read only to
  warn that it differs, never paid to. Zeke's reader has no tools, is told
  the document is data, may answer only seven named fields, and its answer
  is checked against the document text (a value it cannot point to is
  "low"). Pinned with an invoice that tries to change the payee, the amount
  and the recipient.
- **No double payment.** One supplier invoice number is scheduled, waiting
  for approval or paid once per org, by the supplier's name as typed (0057)
  and by the recipient actually paid (0058), so a second spelling of the
  supplier does not pay the same invoice again; the duplicate check runs
  again before the hand-off. The same document is one invoice; the intake
  key is unique per org; one invoice per payment intent; one invoice per Sui
  digest. A step that checked the invoice and then writes (match, the
  duplicate answer, schedule) is a guarded UPDATE on the invoice as it was
  read, so a change in between is refused, not scheduled.
- **Who is paid.** A recipient whose name the supplier's does not suggest
  needs a written reason, kept with the invoice; changing the supplier
  clears the match. A recipient whose wallet is one of Splash's own (the
  operator, the treasury, the FeeConfig fee recipient) is never matched or
  handed off, checked at both steps; when those addresses cannot be read the
  answer is 503 and nothing changes. A PDF's printed account or wallet is
  read by Zeke, kept only in the form of one, and compared; when Zeke did not
  read them the page says the comparison did not run.
- **Fees and rates.** The hand-off carries `feeRule:
  quote_in_transfer_shown_fee_is_max_fee` (Amendment A1: the fee is quoted
  in Transfer and the one shown is the payment's `max_fee`) and no fee of
  its own. A non-USD invoice is not handed off without a rate quote
  (`fx_quote_needed`); no rate is invented.
- **Approval is not here.** Pay invoices hands a scheduled invoice to the
  payment flow (brief 5.4) through `lib/bills/payment-hook.ts`, keyed by the
  invoice id, its attempt and what is paid. That flow is not on this branch: the hook answers 501
  `PAYMENT_FLOW_NOT_WIRED` and nothing changes. Only the server-side
  `recordBillSettlement`, called by that flow, marks an invoice paid; no
  client route reaches it. A paid or cancelled invoice never changes.
- **Fail closed.** No model key: no model reader in any runtime, and a PDF
  is refused rather than read by anything else. No database: the routes
  answer 503. The self-billed e-invoice asks for the business's TIN,
  contact number and the exchange rate, and is not made without them.
- **Scope (WS2).** Every Pay invoices route goes through `billCaller`
  (session org, membership role); another org's invoice is "not found" on
  every handler. Viewers, auditors and developers read only.
- **Get paid: forward-only status.** `PATCH /api/invoices/:id` took any
  status (a settled invoice could go back to draft). It now refuses a
  regression, a "paid" with no reference and a second transfer binding.
  The public pay link no longer marks an invoice paid on the payer's word
  (WS7-3's open note): it records "reported", never overwrites a payment on
  record, and only the business or a USDC payment matched on Sui makes it
  paid. What the payer reports is kept in its own columns (0058), never
  replaces the issuer's reference and is never the evidence for Mark as
  paid, which needs the reference the business typed from its statement; the
  report is a guarded UPDATE on the statuses a payer may report from. Only
  owners, finance admins, approvers and makers (the membership's role) may
  PATCH an invoice, and a transfer it binds to must be the org's own. The
  PATCH's write is guarded on the status it read (second review), so a
  concurrent USDC sync between the two is not overwritten.

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
| WS7-4 | Low | The login limiter was a second implementation on its own `login_attempts` table. **Fixed**: `lib/auth/login-rate-limit.ts` is now a thin layer over the one limiter — failures count, a success clears — with its public API unchanged. `login_attempts` was dropped by migration 0080 (v2 Phase 3), after nothing had written to it. | Fixed |

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
| A-12 | High | The S-10 cap split is **not in effect at runtime**: `anchorCapObjectId()` fell back to `adminCapId`, `.env.example` shipped the key empty, and `recordBatchSettlementOnSui` passed `SPLASH_ADMIN_CAP_ID` directly. The hot key is still the money authority until the ceremony runs. | **Open** — the fallback is gone (an unset `SPLASH_ANCHOR_CAP_ID` now stops the peg refresh rather than borrowing the money key), and Phase 6 removed the reason it mattered most by moving value out of `AdminCap` entirely. The batch PTB this row described (`recordBatchSettlementOnSui`, which took the anchor cap and a tenant's payout delegation) was removed in v2 Phase 3 with the v1 custody payout run; batch payouts are now paid from the business's own wallet and signed by its owners (`docs/v2/phase3-batch.md`), so no batch path uses a Splash-held cap. Still open for the peg refresh until the republish and the ceremony actually run. |
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

## v2 Phase 3 - Zeke never says money moved - 2026-10-31

Design: `docs/v2/phase2-zeke.md` section 2a. Tests:
`tests/zeke-completion-guard.test.mjs`,
`tests/zeke-completion-guard-review.test.mjs`. Phrase tables:
`lib/agent/zeke-claim-patterns.ts`.

- **A model sentence cannot assert execution.** Zeke cannot send, approve or
  sign, but a model can write "Paid!" about a draft (and a prompt-injected
  invoice can ask it to). On any turn that proposes, prepares or discusses a
  money movement, `guardCompletionClaims` (lib/agent/oxwal.ts) removes the
  sentences that say money has been or is being sent, paid or done, and the
  reply carries a fixed line instead: "Nothing has been sent. It is waiting
  for approval." (or, when nothing was prepared, "I haven't sent anything.
  I can't approve or send payments, so a person on your team does that.").
- **Code, not prompt.** Deterministic, no model, no environment read. It reads
  text as a person does (look-alike letters, hidden characters, spaced or
  dotted letters, small caps, accents, stretched words) and in the languages
  of the corridors and the common ones. Negated, conditional and fixed Splash
  copy stay; turns that are not about money are never touched.
- **The list of phrasings cannot be complete, so the reply always carries the
  fixed line.** Recognising a claim is a denylist: a person can always find one
  more way to say "sent", and an independent review found several (see below).
  So the control that does not depend on it: on any turn that reached for a
  money tool, proposed, or prepared a transfer, the model's words are always
  followed by the fixed line, once, whether or not a claim was recognised. "Nothing has
  been sent. It is waiting for approval." when a payment is waiting; "I
  haven't sent anything. ..." when a tool ran and nothing was prepared; for a
  question about whether a payment went through, "I can't tell you whether it
  went through. Open History to see where it stands." A claim the list misses
  is contradicted in the same reply by words only Splash writes. Splash's own
  fixed replies (the planner, a hand-off) already say what is true and get no
  second line. A turn that moved nothing and where nothing was recognised is
  not touched, so a claim there is not caught by this control.
- **Review hardening (2026-10-31).** Opening a sentence with "After", "When",
  "If" or "Before", or a negation word nearby ("Do not worry it has been
  sent"), no longer excuses a claim: a hypothesis ("if it had been sent")
  excuses a past-tense claim only in its own clause, and a negation excuses it
  only when it governs the verb. Matching is bounded (a sentence is read in
  pieces of at most 1,200 characters, a reply of at most 24,000 characters and
  300 sentences; a run of 100,000 commas takes milliseconds, where it took two
  minutes). Invisible characters of every kind (Unicode default-ignorable and
  format characters, Hangul fillers, Braille blank), more look-alikes, HTML
  tags and comments, entities and link syntax are read through. True
  statements of what a record shows ("Invoice INV-1 is paid"), and of what
  Zeke did ("I sent the draft to Wallet for approval"), are kept. A reply that
  talks of money on a turn the message did not mark as one is guarded as a
  discussion of payments.

## v2 Phase 3 - Scheduled batches and the scheduled payer - 2026-11-01

Design and the honest account: `docs/v2/phase3-scheduled-batches.md`. Tests:
`tests/scheduled-*.test.mjs`.

**A trust change, said plainly.** Until now every payment had a person's passkey
behind it. A schedule an owner sets to **pay automatically within my limits**
(Mode B) is paid by a **Splash-held key**, the scheduled payer, with no one
present. The owners' consent is an **allowance they signed** (a spending rule for
that key), not each payment. "Ask me first" (Mode A, the default) is unchanged in
authority: the batch is prepared and the owners' quorum signs it.

- **The scheduled payer is its own AWS KMS key**, separate from the operator's
  gas-sponsor key (`SCHEDULED_PAYER_KMS_KEY_ID`, `SCHEDULED_PAYER_SUI_ADDRESS`;
  `lib/server/scheduled-payer-signer.ts`). It holds no funds and no SUI. Production
  refuses it unless its KMS public key derives the named address and it is neither
  the operator's key or address nor the sponsor's; the boot refuses an
  environment that names the operator's key or address for it. With none
  configured, automatic payments are off and every run is handed back to "ask me
  first". No sandbox signer is reachable in production (the resolver never returns
  one, and the executor refuses one again). Canon D-0004: nothing under the agent
  code reaches it.
- **What a stolen payer key can do** is what its allowance lets it: ask
  `splash_spend` to pay a **recipient the owners verified on the policy**, up to the
  allowance's per-payment maximum, its monthly cap (held by the network) and its
  expiry, and never above the second-approval line (that needs an owner's
  approval, which it can never have). It cannot pay another address, raise a
  limit, add a recipient or touch the wallet. The owners revoke it. The key
  serves every business that gave it an allowance, so the worst case across
  businesses is the sum of their allowances.
- **The daily limit is the server's, not the network's.** `0x2::allowance` carries
  one recurring cap per allowance; the monthly cap is on chain and the daily one
  is enforced by Splash against what automatic runs paid in the last 24 hours. A
  limit asked for waits for the owners' signatures (0070) and applies when the
  request executes; a run reserves its payments under a per-business lock, so
  two runners cannot both pass a limit that fits one.
- **Before Splash signs, it re-checks everything** (`lib/schedule/auto-check.ts`):
  not paused; an owner's schedule by someone still an owner; payer and sponsor
  present; the allowance readable, running and not ending; every payee unchanged,
  a Splash business or wallet, **paid before** (never a first payment to a new
  recipient automatically), screened clear and verified; every payment within the
  per-payment limit and under the second-approval line, the run within the window,
  the daily limit and the fee that was shown; the wallet funded. One failed check
  hands the whole run to "ask me first" with the reason in plain words.
- **At most once.** One run per schedule and due date (unique key); a run claimed
  with a lease; each payment claimed with its digest written first and only while
  its run is still `approved`, unique per business by its payment reference (the
  on-chain idempotency key). An unknown outcome is read back from the chain by its
  digest and never sent again. The bytes are decoded again and held to exactly the
  stored payment (`assertPurposeShape('staff_rule_payment')`) before signing.
- **Instant stops.** Skip, Stop, Edit, Delete, a switch to "ask me first" and the
  kill switch (one owner pauses every automatic payment) take effect for the next
  run and are read before **every** payment of a run in progress. Revoking the
  allowance is a multisig request and takes effect when signed.
- **The grace window (migration 0076), and what it does and does not protect.**
  An automatic run says it is starting GRACE minutes before its first payment (10
  by default; 0 to 60 per business, an owner's own change, instant, on the trail).
  *Does:* nothing is claimed or paid inside the window (the payment claim's own
  statement refuses an early claim, not just the runner); a Skip or Stop inside
  it ends the run as skipped with nothing paid, and cannot race the first
  payment (one statement under the per-business lock); every check is made again
  at its end, so an allowance taken back, a pause, a lowered limit or a changed
  schedule hands the run back instead of paying; stopping can only prevent a
  payment, never cause one; a start that was announced is fixed for that run, so
  the setting cannot be used to bring it forward. *Does not:* it gives the owners
  time to notice and to press a button, not a guarantee that anyone will; a
  stolen payer key does not wait for a window (the allowance's caps bound it, not
  the window); a compromised server could skip the window (the claim's database
  check and the allowance are what remain); it does not make the daily limit the
  network's; and an owner can set it to 0. The notice carries Skip and Stop as
  buttons in the app, which need an owner signed in: no link in an e-mail or a
  WhatsApp message acts by itself, so a message that is read late or by someone
  else can open the app but not stop or start anything.
  *What happens when the notice is not delivered.* The window fails closed. The
  notice is recorded as sent only if it reached at least one owner (the notifier
  answers how many it reached: an e-mail or WhatsApp message the provider
  accepted; no transport, no address or a refusing provider reaches no one). When
  it reached no one the window is closed again and nothing is paid on it; the
  next cron pass opens a fresh window with its full length, and if no owner can be
  told for 24 hours the run lapses unpaid. A window that ends with no notice
  recorded (the runner stopped between opening it and telling anyone) is never
  paid on: the run is handed back to "ask me first" (`window_not_announced`). A
  window still open with no notice recorded is opened afresh. Two limits remain:
  "reached" means a provider accepted the message, not that a person read it, and
  the first pass can come up to five minutes after the due time (the cron runs
  every five), so the window is counted from the notice that went out, not from
  the due time. An owner who sets the window to 0 has chosen no warning at all,
  and a run then pays at its due time whether or not the day-before or running
  notice was delivered. The day-before notice is best-effort: nothing waits on it.
- **A summary the owners read before they sign** is built from the very values the
  allowance request is built from (one parser, one rule, one summary function; tests
  pin that the network holds the summary's figures after the owners sign). What the
  server compares: the request carries a digest of the summary the owner saw (the
  exact payments with their schedule, amount, fee and reference, how often each
  schedule runs and how many runs fall before the end, the per-payment, daily and
  monthly limits, the end day and the window, and what the limits would refuse). The
  server builds its own from the schedules as they are now and asks nobody to sign
  when the digests differ: it answers 409 `summary_changed` with the new summary and
  the owner confirms again. A request with no digest is refused. So a payee added or
  an amount changed after the page loaded cannot be confirmed unseen. The same text
  is stored with the signing request and shown to every owner who signs, beside the
  review decoded from the transaction itself on their device. It is the requester's
  words and not a substitute for that review; when an allowance already exists the
  change may be built as a bridge plus a new allowance, and the device's review is
  what shows that. The end date is a whole UTC day, so a page and a server whose
  clocks differ name the same end on the same day, and every date on the screen is
  a UTC date and says so. The summary marks a payment above the most for one
  payment, a payee never paid before, a run bigger than the daily or monthly limit
  and a schedule that falls after the end, but it cannot predict how several
  schedules together use the monthly limit in a month (it says so), and a run is
  paid whole or handed back whole.
- **Tenant isolation**: every route takes the business from the session; every
  store read takes the org; the runner works each business with its own context;
  the cross-tenant lists are `ForStaff` and return ids only.
- **The cron** (`/api/cron/scheduled-payments`) is bearer-secret protected and fails
  closed (no secret, nobody is authorised, in every environment).
- **Notices carry no link that pays, skips or stops.** E-mail links open the
  signed-in Scheduled tab.
- **Not covered**: the outflow monitor watches the operator, not this key; there
  is no testnet run; a daily limit that is on chain needs a Move change (see the
  hand-off). Sebastian reviews the key policy and the default caps before mainnet.

## v2 Phase 3 - Zeke reads payout sheets - 2026-11-01

Design: `docs/v2/phase3-zeke-batches.md`. Tests: `tests/zeke-sheet-ingest.test.mjs`,
`tests/zeke-sheet-review.test.mjs`, `tests/zeke-legacy-batch-removed.test.mjs`.

- **A sheet is data, read by the server.** `POST /api/wallet/batches/sheet` reads a
  CSV, pasted rows or an .xlsx by fixed rules (`lib/batch/ingest.ts`). Text in a cell
  that talks to an assistant is ignored and cleared; formulas (also full-width
  forms), commands, links and hidden characters of every kind (control and format
  characters, variation selectors, fillers, the Unicode tag block, read first so
  text hidden there is caught) are removed from what is shown back and passed on; each change is recorded on the row. A cell can
  only NAME a recipient: the review matches it to the business's own saved,
  screened recipients, so a sheet cannot introduce a payee, an address or a fee.
- **Caps.** 256 KB, 200 rows scanned, 40 columns, 400 characters a cell, at most 20
  payments (more is refused whole, never cut). A spreadsheet is a zip: its directory
  is read first and one that would expand past 8 MB or 200 parts is refused before
  it is opened. The route reads the body with a cap while reading it, not after.
- **A model never sees a cell.** Only when the headers are unknown, it is given the
  header names (instruction-like headers are replaced by "(column n)") to say which
  is the recipient, amount, reference and currency. The answer is checked against
  the headers and the data. With no key, a wrong answer or an error, nothing is
  guessed. Pasted rows never go into the chat message.
- **Preparing is the wallet batch flow, nothing else.** An owner's batch is one
  signing request for the owners; nothing is drawn until the threshold has signed on
  their devices. A staff member's batch waits for an owner. The sheet's intent id is
  the Idempotency-Key, so a retry or a second tab makes one batch. Zeke's words say
  "Nothing has been sent" and are fixed text, checked against the completion guard.
- **Same gates as every wallet route.** Business from the session; accepted terms;
  owner or staff, never a viewer; rate limit; a body that names a business, role or
  user is a provenance violation. In production a sandbox screening is no
  verification, and a row without one cannot be prepared.
- **The old path is gone.** The `BATCH_PAYOUT` proposal kind, `proposeBatchPayout`,
  the step-up purpose and the helpers only they used are removed; proposals of that
  kind still open are closed once by migration `0072`; one that still reaches the
  executor is recorded as not executed. The `step_up_codes` check constraint still
  lists the old purpose (a superset is harmless).
- **Not covered**: a staff member's batch is not paid inside their rule (the owners
  sign every batch); the column mapper has no live-model test; the floating Zeke does
  not carry a sheet card to the Zeke page. No Move change is needed or made.

## v2 Phase 3 - Staff pay an exchange account alone, when an owner allows it - 2026-11-02

Design: `docs/v2/phase3-team-roles.md` ("Can pay exchange accounts alone") and
`docs/v2/phase3-staff-in-rule.md`. Tests: `tests/exchange-alone-switch.test.mjs`,
`tests/exchange-alone-payment.test.mjs`, `tests/exchange-alone-ui.test.mjs`,
`tests/exchange-alone-review-fixes.test.mjs`.

- **Default deny, on the server, every time.** The owner's per-person switch is
  read from the database before anything is built, again inside the payment's
  claim (on the claim's own connection, under the business's lock), again
  immediately before the Travel Rule message goes, and before every signature
  (`exchangeAloneOf`, `staffExchangeHold`). An owner who turns it off after the
  first read stops the message and the payment: the request just opened is
  withdrawn and the owners are asked (or the person, who insisted on paying
  alone, is told in words and nothing is kept). What is not covered: an owner's
  change that lands after the message has already gone cannot recall it; it stops
  the signature. A viewer, an owner, a stranger, another business's member and a
  stale row all read as no. Only an owner can change it, instantly; every change
  is an append-only trail line.
- **It widens nothing but the payee kind.** The rule's maximum, cap, dates,
  second-approval line (all spenders and payments on their way together) and
  verified recipients still bind, and the recipient must be on the rule as an
  exchange account. A bank payout and another chain stay the owners'.
- **What was read is what was recorded, signed and sent.** The message is built
  on the server; the payment is refused unless the person's confirmation hashes
  the same as the server's own; the payload is stored append-only in the same
  step as the payment's claim, bound to the intent id, and its hash is inside
  the transaction's commitment. The gate re-reads it before each signature and
  compares it with the decoded bytes: the stored text still hashes to its hash;
  the account and the amount the transaction pays; the payment reference the
  bytes carry (the one the message is bound to); and the commitment the bytes
  carry, which the gate derives again from the business, the transfer, the
  account, the amount, the fee bound, the kind and the stored hash
  (`transferCommitmentHex`). A record that is gone, or a transaction that does
  not carry the payment reference and the commitment, is refused. The
  provider's message is made from the stored payload only.
- **Fails closed.** Production without the Travel Rule provider refuses before
  anything is built; a sandbox message is no answer in production; no verdict or
  reference is invented; a business that is not verified, or a recipient missing
  what the exchange needs, is refused in words.
- **What the person is shown is what is sent.** The confirmation lists every
  field of the message, the payment network the money goes over (not the
  exchange's company: see "Whose name the exchange is told" below), and the
  payment details exactly as the provider receives them ("Sent by NAME (Title):
  purpose", or "Sent by COMPANY NAME: purpose" when the business or the person
  chose not to share a name). The provider is told the exchange by its id. Sky
  confirmed the name switches (see below). Nothing in the send
  path (`lib/server/exchange-disclosure.ts`, `lib/server/travel-rule-transfers.ts`,
  `lib/compliance/sumsub.ts`) logs it or sends it to analytics. A message that did not go is read from the
  provider's own row each time the payment is shown (GET
  `/api/wallet/transfers/:request/exchange-message`), so it can be sent again
  after a reload; a replay that confirms another purpose says which purpose the
  exchange was already told.
- **Not covered**: nothing about the exchange's own decision is promised; the
  live path (a real provider, a real passkey signing a sponsored kind-2 payment)
  has not been run, only simulated on the model chain. No Move change is needed
  or made.

## v2 Phase 3 - Limits on automatic payments, and asking Splash for higher ones - 2026-11-02

Spec: `docs/v2/phase3-limits.md`. No Move change.

- **What it controls**: four per-business limits (one automatic payment, a day,
  a month, how long an allowance lasts), standard 2,000 / 5,000 / 20,000 USDC and
  90 days, with ceilings in code (10,000 USDC for one payment, which is the amount
  an owner always approves; 50,000 a day; 500,000 a month; 366 days). A limit
  above its ceiling is refused when asked, refused when staff decide, and clamped
  if ever stored. The second-approval line is never changed by this path.
- **Who**: only owners ask, cancel and lower; the Finance lead sees. Staff roles
  compliance and operations decide; support is refused. The business and the
  actor are the session's in every customer route.
- **Timing**: an approval changes nothing for 24 hours (a table CHECK refuses a
  shorter notice); a pending request changes nothing at all. The owners are told
  when it is approved, declined and started, and can cancel until it starts.
  Lowering is instant and cancels any open request for that limit.
- **Replay**: one Idempotency-Key is one request; a decision made twice is one
  decision; a cancel twice is one cancel; the change is applied by the single
  statement that moves `approved` to `applied`.
- **Audit**: every action is an append-only line with who did it (user id,
  `operator:<email>`, or `system:limits`).
- **Enforcement**: an allowance above a limit is refused; an automatic payment
  above the per-payment limit hands the run back; the daily limit never exceeds
  the business's; the last 30 days of automatic payments must fit the monthly
  limit (checked again under the reservation lock). A run not given the
  business's limits is handed back, never paid without them. The length of an
  allowance holds for the next allowance an owner gives.
- **Keeping what runs** (migration 0079): a business whose signed allowance or
  daily limit was above the standard keeps it, never above a ceiling, with a
  `system:migration` line on the trail, so automatic payments do not stop on
  deploy.
- **Restore**: an owner puts a limit they lowered back at once, up to the highest
  figure the business has held (`held_max`); nothing above it without Splash and
  the 24 hour notice. Trail action `limit_restored`.
- **Not covered**: the 50,000 / 500,000 ceilings need Sebastian and Sky's review;
  a network-held daily cap still needs a `splash_spend` change.

## v2 Phase 3 - Whose name the exchange is told, which partner the screen names, and what the audit proof always holds - 2026-11-02

Design: `docs/v2/phase3-team-roles.md` ("Names sent to exchanges, the network on the screen, and the audit trail"). Tests:
`tests/exchange-names.test.mjs`, `tests/exchange-names-payment.test.mjs`, `tests/payment-networks.test.mjs`,
`tests/payment-trail.test.mjs`. No Move change.

- **Two switches, both on by default, read on the server.** The business's (`organizations.share_names_with_exchange`,
  owners only) and the person's own (`memberships.share_name_with_exchange`, that person only; an owner cannot change
  another's). If either is off, the details read "Sent by COMPANY NAME: purpose" and no person's name or title is in the
  message, in the confirmation, or in the stored copy of the message (only the internal user id is kept). The setting is read
  from the database when the message is built, again when the payment is confirmed (a changed switch changes the message, so the
  person reads it again and confirms again), and again when the message is finally sent: a person who stops sharing after
  confirming is not named, and a switch turned on afterwards never adds a name that was not confirmed. The page cannot choose
  it. A person's name or title is cleaned (control, hidden and direction-changing characters, and brackets, so a name cannot dress
  itself as a title). An owner's change is instant with one append-only trail line; a person's own change writes none.
- **The switches change only what the exchange is told and what the confirmation shows.** The audit proof is built by
  `lib/server/payment-trail.ts` and never reads them.
- **What the audit proof holds (added here, additive).** The sealed evidence record of a wallet payment held the payer, the payee,
  the amount, the fee bound and the reference, and neither the actor nor any approver or decliner. It now carries, inside the
  encrypted record, who started the payment (internal id, role, and the name and title as they were), when, the route
  (owners sign, asked the owners, within a staff rule), the rule it was paid under, and the owners who could approve it
  (`splash.payment-record.v2`; a record without a trail is byte for byte what it was). The record is made before anyone approves, so
  each later signature, decline and owner's answer to an ask is one more sealed record (`splash.payment-decision.v1`) naming the
  first by its hash (`payment_trail_events`, migration 0085; `wallet_transfers.record_hash`). The rows hold internal ids, times
  and hashes only; the name and title are inside the sealed record. A decision is never stopped by a sealing failure: it is on
  record, unsealed, until the cron sweep seals it. In production a demo Seal policy or Walrus blob seals nothing.
- **Names in evidence records are only as private as the key policy.** Sebastian: A-13 above (one operator key can decrypt every
  sealed blob) applies to every name now inside an evidence record. Nothing is stored or anchored in plain text with a name.
  Not covered: the decision records are sealed and stored on Walrus, but only the payment's own record is anchored on Sui (in the
  payment transaction). Anchoring each decision record needs an operator-sent `audit_anchor::anchor_audit_hash` per decision or per
  day (an existing AnchorCap function, no Move change), which is not built. If a payment falls back from a staff rule to the
  owners after its record was made, the record says the route it was built under; the ask and its answer are in the decision records.
- **Which partner the confirmation names: the network, never the processor.** The words say the payment network the person
  knows (`DuitNow` for Malaysia, `InstaPay or PESONet` for the Philippines, `BI-FAST`, `PromptPay`, and so on), never the
  exchange's company or a processor ("Fiuu"), even after an agreement is signed, and still say plainly that the details are shared
  with a payout partner in that country and what exactly is shared. The corridor to network map is one module,
  `lib/compliance/payment-networks.ts`. The Travel Rule message to the provider is unchanged: it carries the real counterparty
  data.
- **The exception: `mustNameReceivingInstitution`.** Per corridor, false by default, changed only in code by Splash compliance
  (not an owner's setting, not a user switch, not read from the database, the environment or a request). Where it is true the
  confirmation names the real institution next to the network ("DuitNow, received by Hata"), and the ban on naming partners has a
  recorded, tested exception for exactly those corridors (`INSTITUTION_NAMING_EXCEPTIONS`; empty as shipped).
- **For Sebastian and compliance, before launch: confirm the wording satisfies data-protection and Travel Rule disclosure.** That
  is: the "Sent by" line and the sentence that says which details are shared, and with whom, in the Malaysia (DuitNow) and
  other corridors; and whether any corridor needs `mustNameReceivingInstitution` set.
- **Other confirmation screens.** Withdrawals and bank payouts still name their partners through `partnerLabel` (the role until
  an agreement is signed, the name after). That is a separate screen and was not changed here; Sky to say whether it should
  follow the same network-name rule.
