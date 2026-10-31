# v2 Phase 3, brief 5.4: Transfer

`/dashboard/transfer` is one flow for paying a business bank account, a
business on Splash or a Sui wallet address. Boards: `Transfer · step 1`,
`step 3`, `How it works pop-up` (`docs/design/v2-previews/boards/`). Send USDC
is Wallet (5.5); this is where a payment is made.

Code: `components/transfer/` (the page), `lib/transfer/` (the rules, shared by
the page and the server), `lib/server/wallet-transfers.ts`,
`payment-record.ts`, `payment-receipts.ts`, `receipt-documents.ts`,
`bill-payment-flow.ts` and `app/api/wallet/transfers/*`. Migration `0064`.

## The five steps

| Step | What it does | Where the rule lives |
|---|---|---|
| 1 Who you're paying | Three cards. A business bank account (PHP and IDR live; MYR, VND, THB, SGD under Pilot access: a Request access form, never a quote), a business on Splash (free), a Sui wallet address. Each card's price is read from the published schedule. | `lib/transfer/payee.ts` |
| 2 Recipient details | **Bank**: a saved supplier account or a new one (owners add; staff are told to ask an owner). One name field (the name the bank holds), one account field, the business or person toggle with one selected state, one input height, one icon gutter, and a **What's needed for PH** (or ID) button that opens a sheet built from the corridor rule. The account is checked with the bank before it is saved and stored sealed. **Splash business**: search by registered name. **Wallet**: an exchange account, a wallet the supplier holds (paid once proven), or USDC on another chain (not payable yet, see below). | `DetailsBank.tsx`, `DetailsBusiness.tsx`, `DetailsWallet.tsx`, `RequirementsSheet.tsx` |
| 3 Amount and pay from | Splash Wallet balance (read from the chain). If short: the shortfall counting the fee, and **Top up and continue** from a verified funding source (the 4.3 routes: a quote first, the top-up made only at a quote the person was shown, the page going on only when the server says the funds arrived). The draft is kept; the rate is quoted after the funds arrive. | `StepAmount.tsx`, `TopUpPanel.tsx`, `lib/transfer/plan.ts`, `lib/transfer/draft.ts` |
| 4 Review and approve | The quote (Splash's fee with its kind, the partner's or Circle's fee as its own line, the rate and what the account receives for a bank payout, the total that can leave the wallet). The fee shown is sent as `max_fee`. **Owners**: the multisig collects signatures; each owner's device decodes the exact bytes itself (`reviewOnDevice`), shows the transaction code, and signs with their own passkey. **Staff** ask the owners, with the reasons named. | `StepReview.tsx`, `SignPanel.tsx`, `lib/transfer/plan.ts` |
| 5 Receipt | The receipt, share by link, WhatsApp, email and PDF, send to the accountant, and the self-billed e-invoice (MyInvois). | `StepReceipt.tsx`, `lib/transfer/receipt.ts` |

The settlement-engine container and the rate-holds list are gone from the
page (a bank payout's quote shows its own hold, with a countdown, on step 4).
**How it works** opens a pop-up over a blurred backdrop with a close X, the
five steps and what the receipt carries.

## The address fix ("invalid Sui address")

Reproduced for the three seeded accounts (`demo@`, `live@`, `fresh@acme.test`,
`scripts/dev-db.mjs`) and each recipient type
(`tests/transfer-addresses.test.mjs`). None of the three has a Splash Wallet, a
passkey address or a saved recipient, so what a person on any of them could hit:

1. an address pasted from a wallet or an explorer with a trailing space, a
   zero-width character, quotes or an upper-case `0X` was refused by the strict
   64-hex tests;
2. a bank account number was tested as a Sui address and the reverse (the SDK
   would pad plain digits into an address nobody holds);
3. a business with no wallet sent a blank sender and was answered with the
   recipient's rule.

`lib/transfer/addresses.ts` is now the one rule: remove what a paste adds
(`cleanPaste`), then `isValidSuiAddress(normalizeSuiAddress(x))` for Sui with
three refusals about money (the `0x` is required, an EVM address and a
truncated paste are never padded), per-chain validators for CCTP destinations,
and a bank payout never checked against a Sui address. The Send desk's
`normaliseSuiAddress` and the recipient form's `suiRecipientAddress` use it
too, and a business with no wallet is told so.

## Who approves (decisions D2 and 4 of 24 Oct)

| Caller | Route |
|---|---|
| Owner | `owners_sign`: a signing request for the owners' multisig (`POST /api/wallet/transfers`, or `/api/wallet/payouts` for a bank). Owners' own limits and recipients are instant. |
| Staff within their rule, below the threshold | `staff_rule` (`splash_spend`). **Not carried out on this server** (`STAFF_RULE_PAYMENTS_WIRED = false`): the staff-side transaction has no builder here. The page says so and the payment goes to the owners (`staff_rule_not_wired`). |
| Staff outside their rule, above the threshold (running total to the same recipient, default 10,000 USDC) or paying a bank or another chain | `ask_owners`, with each reason named. |
| Viewer | Cannot pay. |

## The payment service

`POST /api/wallet/transfers { payee, amountMinor, maxFeeMinor, reference? }`
with `Idempotency-Key` (the intent id). Splash business or a saved wallet or
exchange recipient. A bank recipient answers `use_payout_route`, USDC to
another chain `cross_chain_not_built` (no bridge adapter is registered).

- **Fee.** Splash's fee is read from the schedule on chain for the kind the
  payee is paid as. `maxFeeMinor` below it is `409 fee_changed` with the new
  fee; above the 1% ceiling is `400 fee_above_ceiling`; the fee shown is the
  `max_fee` signed.
- **Idempotency.** The key is unique per business (`wallet_transfers`). The
  same key and payment answers the payment already made; another payment under
  it is `409 idempotency_key_reused`; two requests racing make one; a refused
  payment frees its key.
- **Tenants.** The business is the session's. Another business's recipient,
  payment and receipt read as absent.
- **Refused here:** a bank recipient, USDC to another chain, an address Splash
  controls, the business's own wallet, a wallet not proven, a recipient not
  screened CLEAR.
- **The sealed audit bundle** (`content hash` and Walrus blob behind the
  receipt) is made by the server (`payment-record.ts`) and **fails closed in
  production**: a demo Seal policy or a demo Walrus blob is refused, and
  nothing is stored under a demo policy. `POST /api/wallet/payouts` used to take
  the bundle from the client; it now makes it and ignores one that is sent.
- **Business search** (`GET /api/wallet/transfers/businesses?q=`): a prefix of a
  registered name, three letters or more, five results, verified businesses
  with an account on chain, never the caller; only a name, a country and an id
  come back; limited per person.

## The receipt

Built on the controls evidence (`payment-receipts.ts`): receipt no.
(`SPL-YYMM-XXXXXX`), what the payee received, what was paid, **Splash's fee as
the chain charged it** (the `FeeCharged` event of the executed transaction,
not the bound the owners signed) with its kind and tier label, the partner's
or Circle's fee as its own line (their own, never marked up), the rate, who
paid, who signed (by name), the partner's reference **only when its agreement
is signed**, the Sui digest and a link that opens it on the right explorer. A
payment whose transaction cannot be read is not final. No penalty or late fee
exists.

- **Share.** `POST /api/wallet/transfers/:ref/share { via: 'link' }` makes a
  link that opens one receipt for a month (kept only as a SHA-256, revocable);
  `{ via: 'accountant', to }` emails it from Splash (Resend in production). The
  public page is `/receipt/:token`. WhatsApp and email are links the person
  sends from their own app. The PDF is `GET .../receipt?format=pdf`.
- **Self-billed e-invoice (MyInvois)**, `POST .../e-invoice`: UBL 2.1 JSON,
  type `11`, document version `1.0`, offered only for a settled payment by a
  Malaysian business to a supplier outside Malaysia, once per payment, remade
  at once when its details are corrected (the replaced file's SHA-256 stays in
  the history, so a file already filed can still be told from the new one). The
  business's TIN, contact number, state and the exchange rate are the person's:
  Splash fills in none. The page then opens the MyInvois portal; Splash does
  not submit it.
  **Checked on 31 Oct 2026** against the MyInvois SDK's Invoice v1.0 page
  (`sdk.myinvois.hasil.gov.my/documents/invoice-v1-0/`, which says v1.0 is the
  version without signature validation, kept alongside v1.1, to be replaced
  later) and the LHDN e-Invoice **Specific Guideline Version 4.7, 20 April 2026**
  (self-billed e-invoices, via a secondary report of the release). One secondary
  source named a version 4.9; it was not found on an official page and is not
  cited. The type, TIN and classification codes were last confirmed on 25 Oct
  (`docs/v2/phase3-invoices.md`). Validate in the MyInvois sandbox before relying
  on a new field.

## Pay invoices

`lib/server/bill-payment-flow.ts` is the flow the Invoices hook waits for
(`registerBillPaymentFlow`, registered when the first invoice is handed over).
The invoice's key is the intent id; the fee is quoted and signed as `max_fee`;
`cancel` withdraws a payment nobody has signed; when the owners' request
executes, the invoice is told it was paid only if the transaction paid the
recipient and the amount that were asked (`reportTransferSettled`).

## After the independent review

- A staff member's payment keeps its link to the signing request: accepting the
  ask writes the request back to the payment, and receipts and invoice
  settlement also find a request through its ask. The fee the staff member was
  shown is stored on the ask; owners sign it by default, a lower fee is refused
  and a higher one needs `confirmFeeChange`.
- A second request on one intent id while the first is being made answers 409
  `in_progress`; a claim with nothing behind it for two minutes is reclaimed.
- The Review step shows the full address and country, and asks for a check when
  the recipient was saved in the last 24 hours. The signing screen signs the
  bytes that were reviewed and checks them against what was approved.
- An owner can stop sharing a receipt (`DELETE .../share`); the public page is
  not indexed. The e-invoice is remade at once when corrected.
- Still true: the package and object ids the device checks come from the signing
  request itself (there is no separately pinned public config yet), so the device
  check protects the payee, amount and fee but not those ids.

## Not done here

- **A payment under a staff rule** (`splash_spend::create_intent` and
  `pay_intent`, signed on the staff member's device): no builder. Planned,
  shown, and sent to the owners.
- **USDC to another chain**: a recipient can be saved; the bridge adapter is not
  registered, so it is not payable.
- **Hardware and testnet checks**: nothing was signed or sent on any network.
- **A bank payout from a staff member** is asked of the owners through the
  existing payout route; this page does not add a second path.
- The closing of an invoice's payment when the owners' request **fails** or
  expires is not reported back yet (only execution is).
