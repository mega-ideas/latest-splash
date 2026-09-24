# The stablecoin lane and step-up approvals

Splash sends **USDC on Sui mainnet** to wallet recipients a business has saved.
It is the one lane open to a business that has not finished verification. This
document covers how it works, what must be configured, and what is still open.

## The rules (lib/payments/stablecoin-lane.ts)

| | Unverified business (REGISTERED → KYB_ADMIN_APPROVED) | Verified business (ACTIVE) |
|---|---|---|
| USDC on Sui to a saved wallet | up to **5,000 USDC in any 30 days** | 20,000 per transfer, 500,000 in any 30 days (Tier 3 defaults, mirrored from `business_account.move`) |
| x402 payments | count toward the same allowance | same |
| USD in, local-currency payouts, USD→local conversion | locked | open (sandbox partners in dev) |
| Treasury | locked | open (custody-gated in Phase 0) |

Suspended and rejected businesses get nothing, not even the unverified allowance.

- **Mainnet only.** There is no stablecoin sandbox; the sandbox covers USD in and local-currency out.
- **Asset:** Circle native USDC on Sui (`0xdba3…::usdc::USDC`). There is no native USDT on Sui, only bridge-wrapped versions, so USDT isn't settled.
- **Fee:** 0.80% **on top**, rounded half-up at the micro-unit. The recipient receives exactly what was entered, and the fee goes to `SPLASH_FEE_ADDRESS_MAINNET` in the same transaction.
- **Minimum:** 1 USDC per transfer. x402 payments are exempt.
- **The window rolls:** each transfer counts for 30 days from when it was quoted, so the calendar-month reset trick does not work.

## Recipients

A wallet recipient must be saved first. Splash, and Zeke, only send to saved recipients.

- Saved wallets are **Slush** or **MetaMask with the Sui Snap**. Phantom ended Sui support on 24 September 2026.
- An Ethereum address is refused rather than padded. A padded address is a valid-looking Sui address nobody holds.
- Addresses are screened against Chainalysis's sanctions API when saved:
  - A listed address is refused outright.
  - Without an API key, a wallet can reach a send only if an admin attests to it when saving (recorded with who and when).
- The database enforces the address shape as well as the route (`suppliers_wallet_shape_check`).

## Sending (lib/server/stablecoin-send.ts)

1. **Quote:** validate the recipient, screening, fee address and allowance, then **reserve** the principal under an org row lock, so two quotes can't jointly breach the cap. The reservation lasts 15 minutes. Splash then builds the exact transaction from the sender's own coins.
2. **Approve:** in the workspace's approval style (next section).
3. **Sign:** with the **Splash wallet** (the Sui address of the admin's own passkey) or with Slush / MetaMask (Sui Snap). Wallets sign; they never broadcast.
4. **Submit:** Splash dry-runs the signed bytes and checks the balance changes:
   - the recipient's USDC goes up by exactly the principal;
   - the fee address's goes up by exactly the fee;
   - the sender's goes down by exactly the sum;
   - nobody else's USDC moves.

   Only then does it execute, and it checks the same things on the executed transaction.
5. **Record:** a match is recorded as CONFIRMED with a sha256 audit hash, and the table refuses CONFIRMED without one.
   - A mismatch is recorded as MISMATCH, with the digest.
   - A failure releases the allowance.
   - Each quote is bound to the first signed transaction that leaves Splash. A retry resends that same transaction (one digest, on chain at most once), and a differently-signed second one is refused while the first may still land.

**Audit anchor:** records are kept now with `anchor_status = PENDING_MAINNET_PUBLISH`. They get anchored once Splash's contracts are published on mainnet (not done; that's Sebastian's ceremony).

## The Splash wallet as a wallet (lib/server/wallet-activity.ts)

- **Wallet activity** on Send USDC shows USDC moving in *and* out of the wallet on screen: the Splash wallet, or a connected Slush or MetaMask wallet.
  - It reads the chain through Sui GraphQL (mainnet): the transactions that touched the address, keeping the ones that changed its USDC. So deposits from Slush, an exchange or another chain show up, which Splash's own records cannot know about.
  - Each movement is named from Splash's records: "Sent with Splash to …", an x402 payment, or "Received from …" when the sender is a saved recipient.
  - An outgoing movement from the **Splash wallet** with no Splash record is flagged, because only Splash can sign for a passkey wallet. From a connected wallet it is just "Sent".
  - If the indexer doesn't answer, the panel says so. It never shows an empty wallet instead.
- **All records (CSV)** (`/api/stablecoin/export`) exports every USDC transfer the workspace quoted, including failed and expired ones. Each row has:
  - amount, fee and total, exact to six decimals;
  - who asked for the transfer, and who approved it and how (the approval actually spent);
  - the Sui transaction, and the audit hash.

  Text cells that could start a spreadsheet formula are neutralised.

## x402 (lib/server/x402-pay.ts)

The Send USDC page also pays APIs that answer `402 Payment Required` over x402
v2, in native USDC on `sui:mainnet`. The flow is the same shape as a wallet
transfer, but the **seller's facilitator** broadcasts the payment, not Splash.

- **Probe:** Splash fetches the URL itself, behind a request-forgery guard
  (lib/server/safe-fetch.ts):
  - https only;
  - no private, loopback or link-local addresses;
  - no redirects;
  - timeouts and a size cap.

  A pasted price is never trusted.
- **Quote:** the seller's payee is screened; unscreened sellers need an admin
  attestation. The amount is reserved (kind X402, no Splash fee) against the
  shared allowance.
- **Pay:**
  1. Approve, sign, and dry-run the signed bytes.
  2. Splash re-reads the price; a changed price is refused.
  3. The quote is bound to the signed digest.
  4. `PAYMENT-SIGNATURE` goes only to the URL the price came from.
  5. The digest is confirmed on chain, and the seller's content is shown.
- **Demo seller:** `/api/x402/demo/corridor-fees` sells the corridor fee
  schedule for 0.01 USDC to `X402_DEMO_PAY_TO`. It is off when that's unset.

## Funding a Splash wallet (lib/payments/cctp.ts)

The simplest route is also the recommended one: send **native USDC on Sui**
to the Splash wallet address. The planner (Send USDC → "Fund this wallet
from another chain") plans the rest. It moves nothing. Facts, from Circle's
developer docs as of 2026-09-24:

- **CCTP carries USDC only.** USDT is swapped to USDC on the source chain first, with a slippage floor.
- **Sui is on CCTP V1 (legacy) only**, domain 8. V1 has been in a manual phase-out since **31 July 2026**, ending in a full contract pause.
- **Ethereum (0), Arbitrum (3), Base (6) and Solana (5)** still reach Sui over V1, for now. The planner warns on every plan.
- **Aptos has no CCTP route to Sui.** Aptos is V2-only, and V1 and V2 do not interoperate. The planner says so and offers alternatives.
- **V1 waits for source-chain finality:** about 13–20 minutes from Ethereum and its rollups, under a minute from Solana.
- **Fees:** Circle charges no fee on V1, but each side's gas is paid by the person. Claiming the mint on Sui needs SUI.

Executing CCTP (the source-chain burn and the Sui claim) is not built. The planner gives the exact parameters: domains, and the 32-byte `mintRecipient`.

## Treasury: Ondo USDY in the business's own wallet (lib/payments/treasury-usdy.ts)

- **What it is:** USDC on Sui → Ondo USDY on Sui (`0x960b…56bb::usdy::USDY`, 6 decimals, the same as USDC), held in the business's own Splash wallet. Splash holds neither.
- **Who can use it:** verified businesses only, never US persons.
- **Preview until `USDY_ONDO_ELIGIBILITY_CONFIRMED=true`:** numbers are shown, nothing is swapped.
- **The math:**
  - USDY out = USDC × 10⁶ ÷ price (µUSD), rounded down, with a slippage floor.
  - Projections compound daily at the modelled rate (`USDY_NET_APY_PCT`), rounded down each day.
  - They are labelled variable, not promised.
- **Price:** Pyth's USDY redemption rate (`Crypto.USDY/USD.RR`) when `PYTH_API_KEY` is set, dated by Pyth. Otherwise `USDY_REDEMPTION_USD` with its `USDY_REDEMPTION_AS_OF`. It fails closed.
  - No price: no quote.
  - Stale: flagged.
  - No observation time: no quote. An undated $1.00 is a placeholder; USDY trades above $1.
- **What Sui can actually fill:** every quote also asks the Cetus aggregator (read-only) what a swap of that size would return on Sui right now, and values it at the redemption rate. If that comes out more than 1% short (`MAX_MARKET_SHORTFALL_BPS`), or there is no route, the quote says so and calls the size unfillable. Projections then start from what the business would actually hold.
  - **Measured 2026-09-24:** Sui has very little USDY liquidity. 1 USDC filled within 1%. 100 USDC came back 14.5% short, 1,000 USDC 70.7% short, and 10,000 USDC had no route at all.
  - So a Sui DEX swap is not a treasury route at any real size today. Minting and redeeming with Ondo directly is the alternative. It needs Ondo onboarding and settles in days, and it is not built.

## Prices: Pyth and DeepBook (lib/server/pyth.ts, lib/server/deepbook.ts)

- **Pyth Hermes has required an API key since 26 August 2026.** It is sent as `Authorization: Bearer` (`PYTH_API_KEY`). Pyth's Starter plan is listed at $500 a month.
- Without a key, Hermes answers 401. The adapter used to turn that 401 into a mock $1.00. The peg check, Zeke's peg note and the on-chain peg refresher (`/api/cron/update-peg`) then all ran on a price nobody had measured.
- Now no key, or any failure, means "Pyth unavailable", with the reason. A mock only exists under `USE_MOCK_APIS=true`.
- **The peg check:** DeepBook's USDT/USDC book decides first, then Pyth. With neither, the peg is unverified, and settlement pauses with `peg_unverified` rather than passing.
- **The refresher** pushes nothing without a live Pyth price, so the on-chain `PegState` goes stale and `assert_pegged` refuses settlement. That is the breaker doing its job. Settlements that need a fresh on-chain peg need a Pyth key.

## Step-up approvals (lib/server/step-up.ts)

Each workspace picks a style in **Settings → Approve with a WhatsApp code and passkey**:

- **Off (default): click to approve.**
  - An admin or checker clicks Approve.
  - With *Dual approval above threshold* on, a transfer at or above the approval threshold must be approved by someone other than the person who quoted it (maker-checker), which is the same rule the fiat queue applies.
  - Settings saves need no code.
- **On: WhatsApp code + passkey.**
  - Payments send a code to the **main admin** (the workspace's first admin).
  - Settings and profile saves send it to the editor's own confirmed number, or to the main admin if they have none.
  - The approver enters the code in **their own** session, then signs the approval with their passkey.
  - Codes expire after 10 minutes and lock after 5 wrong attempts. Only an HMAC of each code is stored.
  - **Every single local-currency payout needs one** (the transfer wizard shows the approval before Send). It covers the recipient, their account, the amount, the currency and the payment source; the funding session, quote and screen state the wizard adds afterwards do not change it. If the payout is refused before it exists (travel-rule gap, ceiling, balance), the approval is given back.
  - Batch payouts accept the approval in place of the authenticator code.
  - A payout released from the approval queue was approved there. The queue's approval now counts only for the payment it approved: before, an approved proposal's id could be attached to a different payment.

Every approval is bound to the sha256 of exactly what it approves. It is spent where it is used, where the route recomputes that digest from what it is about to do, so changing one dial or one amount needs a new approval.

**Switching WhatsApp on** is refused until the main admin has a confirmed WhatsApp number **and** a passkey. **Switching it off** is itself a settings save, so it needs a WhatsApp + passkey approval.

**Passkeys can be restored.** WebAuthn hands over a passkey's public key only when the passkey is created. Settings → Security → *Restore a passkey on this device* recovers it from two signatures instead. The device asks twice, and the same passkey must be picked both times. A restored passkey has the same Sui address, so any USDC already sent to it is back in reach. Setting up a *new* passkey creates a new address.

## Before you send (Send USDC)

The page checks what a real mainnet transfer needs, and each open item links to its fix:

- the lane is open, including Splash's fee address;
- an approver can approve (in WhatsApp style: the main admin still has a confirmed number and a passkey);
- a wallet to pay from;
- USDC in that wallet;
- SUI for gas;
- a saved wallet recipient.

Recipient screening is shown as a note: Chainalysis if configured, otherwise the admin vouches for each recipient.

## Configuration

| Variable | Needed for |
|---|---|
| `SPLASH_FEE_ADDRESS_MAINNET` | **Required.** Without it, no wallet transfer is quoted. Never defaulted. |
| `CHAINALYSIS_SANCTIONS_API_KEY` | Screening wallet recipients. Without it, only admin attestation makes a wallet sendable. |
| `SUI_MAINNET_RPC_URL` | Optional. A trusted gRPC-web fullnode; the default is Mysten's public one. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | Delivering codes. |
| `TWILIO_WHATSAPP_CODE_CONTENT_SID` | An approved "verification code" template (`Your {{1}} code is {{2}}`). Without it, codes go as free text, which WhatsApp delivers only within 24 hours of the recipient last messaging the sender. |
| `X402_DEMO_PAY_TO` | The demo x402 seller's payee (0.01 USDC per call). Unset: demo seller off. |
| `PYTH_API_KEY` | Pyth prices: the second peg source, the on-chain peg refresher, and the live USDY redemption rate. Without it Pyth is off (never mocked). Optional `PYTH_HERMES_URL`. |
| `USDY_REDEMPTION_USD` + `USDY_REDEMPTION_AS_OF` | A hand-set USDY price, used only without Pyth. Without the timestamp, no quote. |
| `USDY_ONDO_ELIGIBILITY_CONFIRMED` | `true` only once Ondo confirms eligibility. Until then Treasury is a preview. |
| `FEATURE_KYB_GATE=true` | Locking fiat lanes for unverified businesses. In production it also needs the Sumsub keys. |

## Demo accounts (`npm run dev:db`, password `SplashDemo!2026`)

By default the dev database lives in memory. Set `DEV_DB_DIR=.dev-db` in `.env.local` to keep it on disk, so passkeys, recipients and transfers survive a restart:

- only migrations it has not seen are applied (tracked with a hash in `splash_dev_migrations`);
- the seed runs once;
- a lock file stops a second server opening the same directory.

Stop it with Ctrl+C, and delete `.dev-db/` to start over.

- `live@acme.test`: **unverified**. USDC on Sui mainnet only, 5,000 / 30 days. Fiat and Treasury locked. Zeke refuses local-currency payouts.
- `demo@acme.test`: **verified**. USD in and local-currency out through the sandbox partners; USDC on Sui mainnet is real.
- `fresh@acme.test`: a new business that walks onboarding.

## Known limits

- **The Splash wallet is the admin's passkey.** Lose the passkey and the funds at that address can't be signed for. Hold operating balances there, not reserves.
- **Local development:** the in-memory dev database forgets the passkey's record on restart (the key stays on the device). Restore it in Settings → Security, or run with `DEV_DB_DIR`. Don't leave real funds in a local-dev Splash wallet.
- **MetaMask** reaches Sui only through the Sui Snap, on desktop.
- **Every transfer needs a little SUI for gas** in the sending wallet.
- **x402 on a slow facilitator:** a seller that accepts a payment which then never lands leaves the quote counting until it expires. Retrying resends the same signed payment, so it can't be paid twice.
- **USDY on Sui is thin:** see Treasury. Beyond pocket change, a Sui DEX swap loses heavily or finds no route.
- **Still to come:** executing CCTP (source burn + Sui claim); a USDY route that works at treasury size (Ondo mint/redeem), then executing it once Ondo eligibility is confirmed.
