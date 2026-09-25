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
- **Fee: free** (decision of 2026-09-26, `lib/payments/stablecoin-lane.ts`).
  - **To a Splash user's wallet** (the Sui address of any Splash user's passkey): free, always.
  - **To a wallet outside Splash:** the **audit-anchor fee**, 0.02% with a 0.05 USDC floor and a 5 USDC cap, pays for the record Splash anchors for the transfer. It is built but **off** until `STABLECOIN_ANCHOR_FEE=on`, so today these transfers are free too and the screens say so.
  - When the anchor fee is on, it is charged **on top** and rounded half-up at the micro-unit. The recipient receives exactly what was entered, and the fee goes to `SPLASH_FEE_ADDRESS_MAINNET` in the same transaction.
  - **x402:** no Splash fee.
  - **Network gas** (≈ 0.002–0.004 SUI a transfer) is paid in SUI by the sending wallet until Splash's sponsor wallet pays it (next phase).
- **Local-currency payouts** (outside this lane): **0.70%** of the amount on every corridor, with no fixed fee and no discount tier (`lib/fx/corridors.ts`).
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

1. **Quote:** validate the recipient, screening and allowance; work out whether the recipient is a Splash user (always free) and, if the anchor fee is on, the fee and its address; then **reserve** the principal under an org row lock, so two quotes can't jointly breach the cap. The reservation lasts 15 minutes. Splash then builds the exact transaction from the sender's own coins.
2. **Approve:** in the workspace's approval style (next section).
3. **Sign:** with the **Splash wallet** (the Sui address of the admin's own passkey) or with Slush / MetaMask (Sui Snap). Wallets sign; they never broadcast.
4. **Submit:** Splash dry-runs the signed bytes and checks the balance changes:
   - the recipient's USDC goes up by exactly the principal;
   - when there is a fee, the fee address's goes up by exactly the fee;
   - the sender's goes down by exactly the sum;
   - nobody else's USDC moves.

   Only then does it execute, and it checks the same things on the executed transaction.
5. **Record:** a match is recorded as CONFIRMED with a sha256 audit hash, and the table refuses CONFIRMED without one.
   - A mismatch is recorded as MISMATCH, with the digest.
   - A failure releases the allowance.
   - Each quote is bound to the first signed transaction that leaves Splash. A retry resends that same transaction (one digest, on chain at most once), and a differently-signed second one is refused while the first may still land.

**Audit anchor:** records are kept now with `anchor_status = PENDING_MAINNET_PUBLISH`. They get anchored once Splash's contracts are published on mainnet (not done; that's Sebastian's ceremony).

## Rehearse before the first real transfer (`npm run rehearse:usdc`)

`scripts/rehearse-usdc-send.mjs` runs the lane's real code against Sui **mainnet** and moves nothing:

1. `buildTransferBytes` builds the transaction Send USDC would hand a wallet.
2. `simulateTransfer` dry-runs it, which needs no signature.
3. `verifyStablecoinTransfer` checks the result: the recipient gets exactly the amount, the fee leg exactly the fee, the sender pays exactly both, and nobody else's USDC moves.

It also checks:

- that a quote one micro-USDC different is refused;
- that an empty wallet is told in plain words;
- with `--sender`, that your balances did not change.

Usage:

- `npm run rehearse:usdc` rehearses from a public USDC holder it finds.
- `npm run rehearse:usdc -- --sender 0x… --amount 25` rehearses from your own wallet, e.g. the main admin's passkey address.
- The recipient leg goes to a placeholder address. The fee leg goes to `SPLASH_FEE_ADDRESS_MAINNET` when it is set, so the rehearsal proves the real fee wallet can be paid; otherwise to a placeholder. Nothing is sent.

First run, 2026-09-25: 8/8 on mainnet. It found that a dry run carries its digest only under `effects.transactionDigest`, and the chain reader now reads it from there.

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

## Getting paid in USDC (lib/server/usdc-invoice-payments.ts)

An invoice's pay link offers **Or pay in USDC on Sui**, straight to the issuer's own Splash wallet:

- **Where the money goes.** The receiving address is the Splash wallet of the issuer's main admin (their passkey's address, the same person who approves payments). Splash never holds the money, so this fits Phase 0: nothing is collected on anyone's behalf. If the main admin has no passkey yet, the option is not shown.
- **How a payment is matched.** A Sui transfer carries no memo, so the payer is asked for an exact amount: the invoice amount plus 1–997 millionths of a dollar, fixed per invoice (1,250.00 becomes something like 1,250.000417). **I've sent it — check** reads the issuer's wallet from chain and looks for money in of exactly that amount, which succeeded and did not arrive before the invoice existed.
- **Recorded once.** The matching transaction is stored on the invoice (migration 0024) with one conditional update, and a unique index means one transaction can pay only one invoice. The invoice becomes *paid*, and the issuer's list links to the transfer on Suiscan.
- A different amount is not matched automatically. The issuer reconciles it by hand, as with a bank transfer. The check is public, like the pay link, and limited per network.
- **The issuer doesn't have to wait for the payer.** **Check USDC payments** on the Invoices page matches every open invoice against one read of the wallet and records what it finds. Each transfer goes to at most one invoice, oldest invoice first, through the same conditional update. Invoices already marked paid by a bank report are left alone.
- **Wallet activity names them.** A deposit that paid an invoice shows as "Invoice …123456 paid by Cebu Traders".

## Zeke prepares, you send (lib/agent/usdc-handoff.ts)

Ask Zeke "send 500 USDC to Manila Parts" (or "pay Manila Parts 500 in USDC", "send USDC 500 to Manila Parts", "can you send 75 USDC to Acme?") and it prepares the transfer without sending it:

- Those phrasings are answered in fixed words, before any model runs, the same way the lane refusal does. Other wordings reach the model, which has one way to do it: the READ tool `prepareUsdcTransfer`. That tool runs the same preparation below, and only its Send USDC link becomes a card.
- Every Zeke tool acts for the signed-in workspace. The tool loop replaces whatever `orgId` the model wrote with the session's, and refuses an org-scoped tool when there is no session org (`scopeToolInputToOrg`).
- The recipient must be a **saved wallet recipient** that can be paid (screened or vouched for). A bank recipient, an unknown name or an ambiguous one gets an explanation instead.
- It checks the lane, the 1 USDC minimum, the per-transfer limit and the 30-day allowance with the lane's own functions, and prices the transfer the same way Send USDC does. The fee is free, or the audit-anchor fee when it is on and the recipient is outside Splash, which also needs the fee address. The card shows the amount, the fee, what leaves the wallet, and the allowance left afterwards.
- **Review in Send USDC** opens the send screen with the recipient and amount filled in. The link carries only the saved recipient's id and an amount re-printed from integer minor units; nothing typed in the chat reaches it. Send USDC ignores anything that is not a saved wallet recipient of this workspace.
- Zeke never quotes (a quote reserves allowance), approves or signs. The person continues from the send screen: quote, approval (WhatsApp code + passkey, or a click), and a signature from their own wallet.

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
- **Price:** Ondo's own USDY oracle (`USDYOracleWrapper`, `0x87b1…DF90` on Ethereum), read free with one `eth_call` through a public node (`ETHEREUM_RPC_URL`, default publicnode). It read $1.14730001 on 2026-09-24, the price ondo.finance showed. If the oracle can't be read, the fallback is `USDY_REDEMPTION_USD` with its `USDY_REDEMPTION_AS_OF`. It fails closed.
  - No price: no quote.
  - Stale: flagged.
  - No observation time: no quote. An undated $1.00 is a placeholder; USDY trades above $1.
- **What Sui can actually fill:** every quote also asks the Cetus aggregator (read-only) what a swap of that size would return on Sui right now, and values it at the redemption rate. If that comes out more than 1% short (`MAX_MARKET_SHORTFALL_BPS`), or there is no route, the quote says so and calls the size unfillable. Projections then start from what the business would actually hold.
  - **Measured 2026-09-24:** Sui has very little USDY liquidity. 1 USDC filled within 1%. 100 USDC came back 14.5% short, 1,000 USDC 70.7% short, and 10,000 USDC had no route at all.
  - So a Sui DEX swap is not a treasury route at any real size today. Minting and redeeming with Ondo directly is the alternative, and it is not built:
    - On Sui it goes through Ondo support (support@ondo.finance) with a $5,000 minimum.
    - Ondo onboards institutions only for now, through KYC/KYB with document signing (about 3–4 business days).
    - US persons are excluded. In Malaysia, Singapore, the UK and the EEA only professional or qualified investors can buy.
    - Ondo's instant USDC mint and redeem runs on Ethereum and BNB Chain, not Sui.
    - Ondo publishes no fee schedule and no named program for platforms.
    - Checked 2026-09-25 against docs.ondo.finance.

## Prices: DeepBook and Ondo's oracle (lib/server/peg.ts, deepbook.ts, ondo-oracle.ts)

Splash reads prices only from free sources. Pyth's Hermes has required a paid key since 26 August 2026 (Starter is listed at $500 a month), and Splash chose not to buy one, so Pyth is gone.

- **The peg check reads DeepBook V3**, Sui's on-chain order book, through Mysten's public indexer. It needs no key.
  - It compares USDC with other dollar stablecoins, using a fixed list of pools: `USDSUI_USDC`, `SUIUSDE_USDC` and `USDT_USDC` (`DEEPBOOK_STABLE_PAIRS`).
  - A book counts only if its spread is within 1%. The most-traded one decides.
  - USDT_USDC alone was too thin. At one reading its best bid was 0.321, so payouts would have paused and resumed with it, and anyone could move it for a dollar or two.
  - No usable book means the peg is unverified: payouts pause with `peg_unverified` rather than passing.
  - It cannot see every dollar stablecoin leaving the dollar together. Nothing on Sui prices in dollars without an oracle.
  - A mock exists only under `USE_MOCK_APIS=true`.
- **The on-chain peg attestation** (`update_peg`) needs each coin's distance from the *dollar*. DeepBook prices USDT in USDC, and writing 0 for USDC would be a made-up reading. So nothing is pushed:
  - `PegState` stays stale, and `assert_pegged` refuses settlement.
  - Only splash_custody's settlement reads PegState, and that sits behind the custody gate.
  - Payouts check the peg off chain before they start. `confirm_payment_intent` doesn't read PegState.
- **USDY's price** comes from Ondo's oracle on Ethereum (see Treasury above).

## Step-up approvals (lib/server/step-up.ts)

> **2026-09-26: WhatsApp delivery is dropped for now** (the Twilio account was flagged inactive). Workspaces approve by click. In production, WhatsApp approvals cannot be switched on without Twilio configured (`whatsappDeliveryMissing()`), because a workspace in WhatsApp mode would need a code for every payment and every settings save. See docs/GO-LIVE-HANDOVER.md.

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
  - A payout released from the approval queue was approved there. The queue's approval counts only for the payment it approved (the single payout, or the batch's payable rows and currency) and only once: the route spends it, and the replay closes it whatever the route did. Before, an approved proposal's id could be attached to a different payment, and could pay the same one again after it had executed.

Every approval is bound to the sha256 of exactly what it approves. It is spent where it is used, where the route recomputes that digest from what it is about to do, so changing one dial or one amount needs a new approval.

**Switching WhatsApp on** is refused until the main admin has a confirmed WhatsApp number **and** a passkey. **Switching it off** is itself a settings save, so it needs a WhatsApp + passkey approval.

**Passkeys can be restored.** WebAuthn hands over a passkey's public key only when the passkey is created. Settings → Security → *Restore a passkey on this device* recovers it from two signatures instead. The device asks twice, and the same passkey must be picked both times. A restored passkey has the same Sui address, so any USDC already sent to it is back in reach. Setting up a *new* passkey creates a new address.

## Before you send (Send USDC)

The page checks what a real mainnet transfer needs, and each open item links to its fix:

- the lane is open (with the audit-anchor fee on, that includes Splash's fee address);
- an approver can approve (in WhatsApp style: the main admin still has a confirmed number and a passkey);
- a wallet to pay from;
- USDC in that wallet;
- SUI for gas;
- a saved wallet recipient.

Recipient screening is shown as a note: Chainalysis if configured, otherwise the admin vouches for each recipient.

## Configuration

`npm run doctor` (and `GET /api/health`, staff-only in production) checks this setup; the checks live in `lib/server/go-live-checks.ts`. Each check reads one of three ways:

- **ok**: set up and working.
- **skipped**: not set up yet. The line says what stays closed until it is.
- **FAIL**: set but wrong (a rejected key, a passkey domain the browser will refuse), or a price source that didn't answer.

The checks are:

- the USDC lane's mainnet node;
- the DeepBook peg;
- Ondo's USDY price;
- the fee wallet;
- Twilio (an account lookup; nothing is sent);
- the passkey domain against the app's host;
- the Chainalysis key.


| Variable | Needed for |
|---|---|
| `SPLASH_FEE_ADDRESS_MAINNET` | Splash's fee wallet. Needed only when the audit-anchor fee is on; stablecoin transfers are free without it. Never defaulted. |
| `STABLECOIN_ANCHOR_FEE` | `on` charges the audit-anchor fee (0.02%, min 0.05, max 5 USDC) on USDC sent out of Splash. Blank or `off`: free. |
| `PLATFORM_FEE_BPS`, `FIXED_FEE_CENTS`, `FUNDING_DISCOUNT_BPS` | Local-currency pricing knobs: fallback fee for a currency with no corridor (70), fixed fee (0) and USDC-funded discount (0). Leave them at those values: pricing is 0.70% flat. |
| `CHAINALYSIS_SANCTIONS_API_KEY` | Screening wallet recipients. Without it, only admin attestation makes a wallet sendable. |
| `SUI_MAINNET_RPC_URL` | Optional. A trusted gRPC-web fullnode; the default is Mysten's public one. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | Delivering codes. |
| `TWILIO_WHATSAPP_CODE_CONTENT_SID` | An approved "verification code" template (`Your {{1}} code is {{2}}`). Without it, codes go as free text, which WhatsApp delivers only within 24 hours of the recipient last messaging the sender. |
| `X402_DEMO_PAY_TO` | The demo x402 seller's payee (0.01 USDC per call). Unset: demo seller off. |
| `DEEPBOOK_STABLE_PAIRS` | Optional. The dollar-stablecoin/USDC pools the peg is read from. Default `USDSUI_USDC,SUIUSDE_USDC,USDT_USDC`. |
| `ETHEREUM_RPC_URL` | Optional. The Ethereum node Ondo's USDY oracle is read through. The default is publicnode; use one you trust before Treasury moves money. `USDY_ORACLE=off` skips the oracle. |
| `USDY_REDEMPTION_USD` + `USDY_REDEMPTION_AS_OF` | A hand-set USDY price, used only when the oracle can't be read. Without the timestamp, no quote. |
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
