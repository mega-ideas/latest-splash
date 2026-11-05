# v2 Phase 3, brief 5.7: Treasury in the business wallet

D9: Treasury v1 is Ondo USDY on Sui, swapped in the business's own wallet
and labelled not Shariah. Halogen funds are offered by referral, with an
eligibility check and a read-only holding view. Ondo tokenized stocks are a
later phase, behind a flag that is off.

## What changed

- `/dashboard/treasury` no longer reads the custodial Smart Treasury ledger
  (`/api/treasury`) and has no `custody_not_licensed` gate. It reads
  `GET /api/treasury/wallet`, which resolves the business wallet on the
  server from the org's own BusinessAccount
  (`lib/server/treasury-business-wallet.ts`: `organizations.sui_business_account_id`,
  then the object's `wallet` field, the same reading Phase 2's
  `parseBusinessAccount` makes) and returns its USDC and USDY from Sui. The
  page names no address. It keeps the earlier concept: two vessels (USDC
  and USDY), a direction-aware channel holding the control, a single-series
  projection, the netting simulator, activity, how it works, and the risk
  card. Every figure comes from the chain, a quote or the business's own
  records. The seeded yield series and the notice withdrawals are gone, since
  a wallet redemption has no notice period.
- The custodial Smart Treasury ledger is retired, custody phase or not
  (`lib/server/custodial-treasury.ts`, a constant that is off and that
  `npm run check:treasury-wallet` keeps off). `/api/treasury` answers 410
  before the custody phase is read, an approved `TREASURY_ALLOCATE` or
  `TREASURY_REDEEM` proposal is recorded and not carried out, and nothing
  replays into the ledger route. Zeke's Treasury answer no longer depends on
  the custody phase: it opens with the limitation statement ("I can't
  prepare, approve or send a Treasury swap"), points to the business's own
  Splash Wallet and the Treasury page, mentions signing only when this server
  has a swap route, and cites no licence. Settings says the same and names no
  issuer; automatic allocation is not offered. The accrue-yield and
  settle-withdrawals crons still sit behind the custody phase; with the ledger
  unreachable they have nothing new to act on, and they are left for the
  ledger's removal.
- Customer-facing reasons name the issuer and the fund manager only through
  `lib/partners/signed-partners.ts`. Until `SIGNED_PARTNERS` names them, they
  are "a tokenized treasury issuer" and "a fund manager".

## Routes

| Route | Who | What |
|---|---|---|
| `GET /api/treasury/wallet` | any member | flags, whether this member may order (`canOrder`, from the server's role list), partner labels, USDY price, modeled rate, this org's orders, and the business wallet's USDC and USDY (resolved on the server; public chain data, not stored; a chain error is a fixed sentence) |
| `POST /api/treasury/wallet/quote` | any member | `{direction: swap\|redeem, amount}`: the value at the redemption rate and what the Sui market returns right now. Moves nothing |
| `GET/POST /api/treasury/wallet/orders` | owner, finance admin, approver, maker (not a viewer, auditor or developer) | `{intentId, direction, amount, minOutMinor}`: hands the swap to the wallet's signers |
| `GET/POST /api/treasury/fund-referral` | read: any member; write: owners | `assess`, `opened`, `link`. Answers 404 while `FEATURE_FUND_REFERRAL` is off |
| `GET/POST /api/admin/treasury/fund-referrals` | staff session | every referral; `?orgId=` for one business's full history; POST `{orgId, reason}` (support or compliance) releases a linked reference |

Every route goes through `lib/server/treasury-route.ts`, which requires the
customer session, the launch scope and `requireSessionAccount`. It takes the
org from the session and the role from the membership row, never from the
request.

## Orders

`treasury_wallet_orders` (migrations 0058 and 0059) holds one swap or
redemption per (org, intent id), bound to the business wallet. The server
resolves the wallet, never the client, and records it as both
`source_address` and `recipient_address` (a CHECK keeps them equal), with
both coin types (another CHECK keeps them different). The swap route's
`prepare(order)` receives all four, so whatever builds the transaction is
told where the coin comes from and that the output goes back to the same
wallet, and nowhere else. The amount is checked against what the wallet holds
on Sui when the order is made (USDC for a swap, USDY for a redemption), before
the market is asked; above it the order is refused (`over_balance`). A
request that meets an order another request is still handing to the signers
(no provider reference yet) is told it is in progress (409), never that it
was sent. The intent id is the client's idempotency key. A replay
returns the existing order without pricing it again or calling the swap route
a second time. Racing requests produce one row. The same id used with a
different direction or amount is refused. The order uses the server's quote.
The client sends the least it agreed to receive (`minOutMinor`, which works
like a payment's `max_fee`), and the order is refused if the market no longer
reaches that figure. The stored floor is the higher of that figure and the
server's slippage floor. Status only moves forward from `awaiting_signatures`.
No Splash fee is charged on a swap (A1): the cost of the route is the
market's shortfall, which every quote shows.

The swap route is an adapter (`lib/server/treasury-providers.ts`). It is off
unless `TREASURY_WALLET_SWAPS=true`, and outside production it is a sandbox,
marked `sandbox` on every order and shown as such. In production this build
has no live route, because the Phase 2 wallet signing service refuses foreign
packages and non-USDC assets (`lib/wallet/wallet-tx-describe.ts`). So
production answers 503 and records nothing. A live route has three
requirements: the describer must accept a USDC-to-USDY DEX swap from this
wallet; the signer's screen must show the exact transaction bytes, hashed,
with the recipient, both coin types, the amount and the floor read from the
transaction itself and checked against the order's `recipient_address`,
`in_coin_type`, `out_coin_type`, `amount_in_minor` and `min_out_minor`;
and `closeTreasuryOrder` must be called when the signing request executes.
The balance check reads the wallet's whole balance; when this merges with
Phase 2, it should subtract the USDC Phase 2 withholds (`heldUsdc`), and the
wallet resolver should call Phase 2's `readAccount()`.

What the second 5.7 review changed:

- A preview quote (`mode: 'SANDBOX'`, issuer eligibility not confirmed) is
  never an order, on any route: the order answers 409 `issuer_unconfirmed`
  and records nothing. An order on the sandbox route is labelled as one all
  the way through: the button reads "Record a sandbox order", the toast
  "Recorded in the sandbox. Nothing was sent to your owners.", and the
  activity row "Sandbox, not sent". "Sent to your wallet's owners to sign"
  is shown only for an order the server returned with `sandbox: false`.
- The overview returns `swapRoute` from `resolveTreasurySwapRoute`, the same
  resolver the order uses (`{ok, kind}` or `{ok: false, reason}`). The
  page's status line, send button and its reason follow it, not
  `TREASURY_WALLET_SWAPS`, so in production with the switch on the page
  says there is no live route instead of offering a send that answers 503.
- Every read of an order applies its expiry (`asOf` in
  `treasury-wallet-orders.ts`), so replaying a lapsed intent id returns it
  as `expired`, as the list does.
- A swap in on a STALE price is not orderable (the fillable check values the
  market against that price). A redemption stays open, bound by the Sui
  market figure and the floor the person agreed to.
- `businessAccountWallet` accepts a BusinessAccount only from a configured
  splash_core package (`corePackageId`, or the legacy `packageId`), and
  refuses all when none is configured.
- When `SUI_NETWORK` is not `STABLECOIN_NETWORK` (mainnet, where USDY is),
  the wallet resolver answers `network_mismatch`: no balance is shown and no
  order is made, instead of showing mainnet coins for a wallet whose policy
  lives on another network.
- The projection chart takes keyboard focus and steps with the arrow keys,
  Home and End; the value line above it is a polite live region. The page
  has bottom room at phone width for the floating Zeke button.

Swap slippage is one setting, `USDY_SWAP_SLIPPAGE_BPS`, read through
`lib/env.ts`: 30 by default, and refused above 100
(`MAX_SWAP_SLIPPAGE_BPS`, the same as the market shortfall ceiling).

Redemptions are never locked by verification or by country, so a business
holding USDY can always get out. Swaps in are locked for unverified and US
businesses (`treasuryQuote`).

## Fund referral (behind `FEATURE_FUND_REFERRAL`, off)

The eligibility questions in `lib/treasury/fund-eligibility.ts` follow the
Securities Commission Malaysia's sophisticated-investor categories that a
business can meet:

- a regulated institution listed as an accredited investor;
- total net assets above RM10 million on its latest financial statements;
- wholly owned by accredited investors, high-net-worth entities or
  high-net-worth individuals.

An owner answers for the business and declares the answers true. Splash
records them and checks nothing further, and the fund manager makes its own
checks. Only an eligible business sees the referral link (`FUND_REFERRAL_URL`,
https only) and can link its account reference. A typed reference is a
claim, not a link: the fund manager is asked to confirm that the reference
belongs to this business, by its registration number
(`FundHoldingSource.confirmLink`), and nothing is stored unless it says yes.
So a business cannot take another business's reference by typing it first.
Every holding read names the business too (`read({ reference, orgId,
registrationNumber })`). A reference stays unique across businesses. Once an
account is linked, the answers cannot be changed. Support or compliance can
release a link, with a reason.

Nothing is overwritten without a trace: every assessment (who, when, the
answers and the outcome), every confirmed link and every release is appended
to `treasury_fund_referral_history` (migration 0059), and the current row
points at the latest assessment. A business that first declared it did not
qualify and then answered again still shows the first declaration, to itself
and to staff. Whether answering again after a "not eligible" result needs a
waiting period or staff review is for legal to decide. The holding is read
through an adapter. Outside production that adapter is a sandbox and its
figures are marked "Sandbox figures". In production nothing is read until the
fund manager provides a contracted read-only API, and no figure is shown.

The wording here and the questions need legal sign-off before mainnet
(docs/MAINNET-CHECKLIST.md).

## Not done here

- The live swap route, and executing an order. Both depend on the Phase 2
  signing service accepting the swap.
- The fund manager's holdings API.
- Tokenized stocks (`FEATURE_ONDO_STOCKS`): when the flag is on, the page shows
  only a short description card with a link to Support.
