# v2 Phase 3, brief 5.5: Wallet

`/dashboard/wallet` is the business's own wallet. It was today's Send USDC
page; it keeps that page's look (the same `dash-block` and `dash-surface`
cards, kicker, tokens and spacing) and loses what moved out of it: sending a
payment is Transfer's (5.4), USDY is Treasury's (5.7). The Send USDC desk,
its USDY preview and its funding planner are deleted.

Code: `components/wallet/` (the page), `lib/wallet-page/` (the words and rules,
pure, shared by tests and page), `lib/server/wallet-overview.ts`,
`lib/server/org-member-names.ts` and `app/api/wallet/overview`. Everything
else the page calls already existed from Phase 2 (§4.1 to §4.4).

## What the page shows

| Section | Reads | Notes |
|---|---|---|
| Balance | `GET /api/wallet/overview` | USDC in the wallet, what is on hold, what can be paid. An unreadable balance is "Not available", never zero. Held by the business: Splash has no key. |
| Needs your signature | `GET /api/wallet/signing-requests` | Every request waiting on this person. Opening one decodes the exact bytes on the person's own device (`reviewOnDevice`), shows the transaction code to compare with WhatsApp, and signs those bytes with their passkey. Wallet changes read in plain words (`lib/wallet-page/actions.ts`). |
| Create your business wallet (4.1) | `GET/POST /api/wallet/business` | Owners and passkeys by name, owners without a passkey (left out only by name), a single signer only when a sole owner chooses it. Only the founder (the business account's own owner) starts it; the registration goes to the owners' inbox. |
| Add funds (4.3) | `/api/wallet/funding*` | Bank or card through a funding partner, a Sui wallet (address, paste a digest to look for a transfer), another chain by CCTP V2. The quote comes first; a top-up is made only at a quote the person saw (`acceptedArrivesMinMinor`), under one Idempotency-Key per attempt. A partner's or the network's fee is its own line; Splash adds none. |
| Withdraw to your own bank (4.4) | `/api/wallet/withdrawals*` | Quote, then ask the owners to sign. The fee shown is `maxFeeMinor` and the least the bank gets is `acceptedReceiveMinor`. Owners set up the route (bank account in the company's name, the partner's fixed deposit address, one 1 USDC test deposit); staff ask. |
| Funding history | `GET /api/wallet/funding/deposits` | Ready to use, held with the reasons, or blocked. USDT and USDsui are their own list, shown as the coin that arrived and never counted as USDC. |
| Funding sources (4.3) | `/api/wallet/funding/sources*` | Verified or checking, and how each gets checked. Owners add a bank account in the company's name or a wallet and prove a wallet with a signature (a Sui wallet signs in the browser; any chain can paste a signature). A card is added by the funding partner, never typed here. |
| Wallet activity | `GET /api/stablecoin/activity?address=` | The wallet's public chain history. |
| Signers and threshold | overview | "2 of 3", who, and (owners) a change of signers: the current signers approve, then the new ones confirm. |
| Spending rules (4.2) | `GET /api/wallet/spending-rules` | What each staff member may pay alone and what is left in the day or month, read from the chain; the second-approval threshold; near-threshold flags (owners only); a reissue warning after a rotation. Rules are given and changed in Settings. |
| Move to your business wallet (4.1) | `/api/wallet/migration*`, `/persons-in-charge` | See below. |
| Upgrade alerts | the layout's own reader | The contract and fee-schedule changes announced to this owner, still active. The old Settings link (`/dashboard/settings/spending-rules`) redirects to this page's rules. |

Every state is a sentence: wallets off on this server, the chain not answering,
no wallet yet, a wallet being set up, and the viewer's limits.

## Add funds and Withdraw: who sees them

Both are an owner's to give (Sky, 31 Oct). Owners have them; a staff member or an
approver only when an owner switched them on in Settings → Team, each on its own;
a viewer never. `GET /api/wallet/overview` carries `access` (what this person may
do), and the page offers Add funds and Withdraw, on the balance and as sections,
only from it. Someone without either is told an owner can turn them on. Anyone can
still send USDC to the wallet from any wallet; a deposit is screened and held as
before. See `phase3-team-roles.md`.

## Move to your business wallet

USDC only. Each member's USDC at their own passkey address moves in one plain
transfer that they sign on their own device. An owner moves their own at once.
Anyone else needs a sign-off from an owner or the person in charge, signed
with that person's passkey over a statement naming the business, the member,
USDC, the source, the business wallet, a nonce and a 24-hour expiry. Nobody
signs off their own move, and a person in charge moving their own needs
another sign-off. An owner appoints or takes back the person in charge here;
a person in charge moves no money and signs nothing on the wallet.

`GET /api/wallet/migration` is now scoped to the viewer: owners and the person
in charge read every member's address and balance, anyone else their own
only, and the chain is asked only for what the viewer may see. Each row says
whether it is cleared, read from the same check the move itself makes, and
`lib/wallet-page/migration.ts` words what the viewer can do about it: move,
sign off, ask, wait, or (a passkey of another site) move it from there.

## Changes to the server

- `POST /api/wallet/withdrawals` made no audit bundle of its own: it passed a
  content hash and Walrus blob id from the caller to the owners' signing
  request. It now builds the sealed record the way the supplier payout route
  does (`lib/server/payment-record.ts`): the business name, the saved bank
  account's holder, the parsed amount and fee. Production refuses a demo Seal
  policy or a demo blob; a retry of a known Idempotency-Key is answered
  before anything is sealed; a bundle named in the request is ignored.
- `GET /api/wallet/overview` (new): role, wallet state, balance, holds,
  signers. The business is the session's; nothing is read from the request.
- Names: the business, migration, persons-in-charge and spending-rules routes
  answer names, read through the business's own memberships only
  (`lib/server/org-member-names.ts`). The list of members to choose from for
  a person in charge goes to an owner only.

## Tests

`tests/wallet-overview.test.mjs`, `wallet-page-migration.test.mjs`,
`wallet-page-labels.test.mjs`, `wallet-page-rules.test.mjs`,
`wallet-members-view.test.mjs`, `wallet-withdrawals-route.test.mjs` and
`wallet-page-ui.test.mjs`: states, the viewer's scope, tenant boundaries
(session business only; members through the membership join), fail-closed
bundles in production, one key per attempt, the quote bound to what is sent,
the copy rules, no coral, Demo, testnet or unsigned partner name, and that the
page quotes and sends nothing itself.

## Not done here

- **x402 payments.** The Send USDC desk was the only screen that paid an API
  over x402. It is gone with the desk; the routes (`/api/x402/*`) remain.
- **Swap routes** for other tokens (Li.Fi, deBridge) are in the funding
  service but have no screen here: the person would have to name a token and
  its decimals, and both routes are sandbox-only.
- **Converting USDT and USDsui to USDC** is not built (the funding service
  refuses it: `conversion_not_built`), so they arrive and stay as they are,
  and the page says so.
- **Zeke's handoff** still links to `/dashboard/wallet?to=&amount=`. The page
  carries that query to Transfer unchanged, but Transfer does not read it
  yet, so it opens empty.
- **Staff paying within a rule** and **cross-chain payments** are Transfer's,
  and not built there either (`docs/v2/phase3-transfer.md`).
- **No transaction was signed or sent on any network**, and the hardware 2-of-3
  check and the sponsored-gas dry runs remain Sky's (`docs/v2/phase2-business-wallet.md`).
