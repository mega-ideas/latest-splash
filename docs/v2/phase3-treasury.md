# v2 Phase 3, brief 5.7: Treasury in the business wallet

D9: Treasury v1 is Ondo USDY on Sui, swapped in the business's own wallet
and labelled not Shariah. Halogen funds are offered by referral, with an
eligibility check and a read-only holding view. Ondo tokenized stocks are a
later phase, behind a flag that is off.

## What changed

- `/dashboard/treasury` no longer reads the custodial Smart Treasury ledger
  (`/api/treasury`) and has no `custody_not_licensed` gate. It reads the
  business wallet's address from the Phase 2 `GET /api/wallet/business`. It
  then reads that wallet's USDC and USDY from Sui through
  `GET /api/treasury/wallet`. It keeps the earlier concept: two vessels (USDC
  and USDY), a direction-aware channel holding the control, a single-series
  projection, the netting simulator, activity, how it works, and the risk
  card. Every figure comes from the chain, a quote or the business's own
  records. The seeded yield series and the notice withdrawals are gone, since
  a wallet redemption has no notice period.
- The custodial `/api/treasury` route, its crons and Zeke's ledger tools keep
  their custody gate, which is still correct for a ledger Splash would hold.
  When Zeke refuses a Treasury request it now points to the business's own
  Splash Wallet and the Treasury page, and it cites no licence.
- Customer-facing reasons name the issuer and the fund manager only through
  `lib/partners/signed-partners.ts`. Until `SIGNED_PARTNERS` names them, they
  are "a tokenized treasury issuer" and "a fund manager".

## Routes

| Route | Who | What |
|---|---|---|
| `GET /api/treasury/wallet[?address=]` | any member | flags, partner labels, USDY price, modeled rate, this org's orders, and the given wallet's USDC and USDY (public chain data, not stored) |
| `POST /api/treasury/wallet/quote` | any member | `{direction: swap\|redeem, amount}`: the value at the redemption rate and what the Sui market returns right now. Moves nothing |
| `GET/POST /api/treasury/wallet/orders` | owner, approver, maker (not a viewer) | `{intentId, direction, amount, minOutMinor}`: hands the swap to the wallet's signers |
| `GET/POST /api/treasury/fund-referral` | read: any member; write: owners | `assess`, `opened`, `link`. Answers 404 while `FEATURE_FUND_REFERRAL` is off |

Every route goes through `lib/server/treasury-route.ts`, which requires the
customer session, the launch scope and `requireSessionAccount`. It takes the
org from the session and the role from the membership row, never from the
request.

## Orders

`treasury_wallet_orders` (migration 0055) holds one swap or redemption per
(org, intent id). The intent id is the client's idempotency key. A replay
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
production answers 503 and records nothing. A live route has two
requirements: the describer must accept a USDC-to-USDY DEX swap from this
wallet, and `closeTreasuryOrder` must be called when the signing request
executes.

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
https only) and can link its account reference. A reference is unique across
businesses, so no business can read a holding another business has linked.
Once an account is linked, the answers cannot be changed. The holding is read
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
