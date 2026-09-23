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
  - In this style, batch and fiat payouts accept the approval in place of the authenticator code.

Every approval is bound to the sha256 of exactly what it approves. It is spent where it is used, where the route recomputes that digest from what it is about to do, so changing one dial or one amount needs a new approval.

**Switching WhatsApp on** is refused until the main admin has a confirmed WhatsApp number **and** a passkey. **Switching it off** is itself a settings save, so it needs a WhatsApp + passkey approval.

## Configuration

| Variable | Needed for |
|---|---|
| `SPLASH_FEE_ADDRESS_MAINNET` | **Required.** Without it, no wallet transfer is quoted. Never defaulted. |
| `CHAINALYSIS_SANCTIONS_API_KEY` | Screening wallet recipients. Without it, only admin attestation makes a wallet sendable. |
| `SUI_MAINNET_RPC_URL` | Optional. A trusted gRPC-web fullnode; the default is Mysten's public one. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | Delivering codes. |
| `TWILIO_WHATSAPP_CODE_CONTENT_SID` | An approved "verification code" template (`Your {{1}} code is {{2}}`). Without it, codes go as free text, which WhatsApp delivers only within 24 hours of the recipient last messaging the sender. |
| `X402_DEMO_PAY_TO` | The demo x402 seller's payee (0.01 USDC per call). Unset: demo seller off. |
| `FEATURE_KYB_GATE=true` | Locking fiat lanes for unverified businesses. In production it also needs the Sumsub keys. |

## Demo accounts (`npm run dev:db`, password `SplashDemo!2026`)

- `live@acme.test`: **unverified**. USDC on Sui mainnet only, 5,000 / 30 days. Fiat and Treasury locked. Zeke refuses local-currency payouts.
- `demo@acme.test`: **verified**. USD in and local-currency out through the sandbox partners; USDC on Sui mainnet is real.
- `fresh@acme.test`: a new business that walks onboarding.

## Known limits

- **The Splash wallet is the admin's passkey.** Lose the passkey and the funds at that address can't be signed for. Hold operating balances there, not reserves.
- **Local development:** the dev database is in memory, and a restart forgets the passkey's record (the key stays on the device). Don't leave real funds in a local-dev Splash wallet.
- **MetaMask** reaches Sui only through the Sui Snap, on desktop.
- **Every transfer needs a little SUI for gas** in the sending wallet.
- **x402 on a slow facilitator:** a seller that accepts a payment which then never lands leaves the quote counting until it expires. Retrying resends the same signed payment, so it can't be paid twice.
- **Still to come:** the CCTP funding planner, and Treasury (USDC → Ondo USDY; verified businesses only; non-US; allowlisted).
