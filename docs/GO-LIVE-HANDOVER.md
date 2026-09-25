# Go-live handover (for Sebastian)

Written 2026-09-26. This covers where each setup step stands, the decisions taken and why, and what is left for you. The live check for all of it is `npm run doctor` locally, or **Go-live** in the staff console (`/admin/go-live`) in production.

| # | Step | Status |
|---|---|---|
| 1 | Prices | Done. DeepBook for the peg, Ondo's oracle for USDY; no paid feed. |
| 2 | Treasury (USDY) | Stays a preview. The founder has emailed Ondo about platform access. |
| 3 | Fee wallet | Set on the founder's machine. Optional in production while stablecoin transfers are free (below). |
| 4 | WhatsApp codes (Twilio) | **Dropped for now.** Approvals are by click. |
| 5 | Passkey domain + the main admin's passkey | Domain decided: `splashz.xyz`. **Passkey not created yet: yours to do.** |
| 6 | Rehearse the first transfer | Dry run passed on mainnet. **The real 1 USDC send waits on step 5.** |

## Pricing (decided 2026-09-26)

| What | Price | Why |
|---|---|---|
| USDC to another Splash user's wallet | **Free**, always | It never leaves Splash. |
| USDC to a wallet outside Splash | **Free for now.** Later, the **audit-anchor fee**: 0.02%, min 0.05, max 5 USDC | The fee pays for the record Splash anchors per transfer, a fixed cost, hence the floor. The cap keeps large treasury moves cheap. It stays off (`STABLECOIN_ANCHOR_FEE` blank) until switched on, for example after a deal with Sui. |
| x402 payments | Free | The seller sets the price. |
| Sui network gas on USDC transfers | Paid in SUI by the sending wallet **today**; Splash's own sponsor wallet will pay it | The founder chose a Splash-run sponsor wallet over Enoki, whose mainnet sponsorship needs the $120/month Professional plan. It is being built next and needs a funded SUI wallet and its key on the server. |
| Local-currency payouts (all 11 corridors) | **0.70%** of the amount, flat | Replaces 0.80–1.10% per corridor plus a fixed RM 4.50. There is no fixed fee and no discount for paying from held USDC. Each corridor keeps its own `feeBps` (all 70), so one can differ later. |

Production environment, to match:
- `PLATFORM_FEE_BPS=70`: the fallback for a currency with no corridor. The founder's `.env.local` had 140.
- `FIXED_FEE_CENTS=0`, and delete `FIXED_FEE_SEN`: nothing ever read it (the code reads `FIXED_FEE_CENTS`).
- `FUNDING_DISCOUNT_BPS=0`.
- Leave `STABLECOIN_ANCHOR_FEE` blank.

The `DISCOUNT` / `STANDARD` funding tier labels stay in the data model because they are part of existing approvals' fingerprints. Both now price at 0.70%.

## 3. Fee wallet

`SPLASH_FEE_ADDRESS_MAINNET` is Splash's fee wallet. It is **needed only once the audit-anchor fee is switched on**; stablecoin transfers are free without it. The founder created it in Slush: `0x0ca0…a5fe` (the full value is in the founder's `.env.local`).

- On 2026-09-26 it was checked on Sui mainnet: it is a wallet address, not an object ID. That matters because the two look identical, and fees sent to an object ID would be owned by that object and unreachable. Doctor now checks this every run.
- It was first typed into `.env.example` by mistake. The app never reads that file, so the lane stayed closed, and a commit would have published it. It was moved to `.env.local`, and a test now fails if `.env.example` ever holds a value for it.
- **To do (optional now):** set the same value as `SPLASH_FEE_ADDRESS_MAINNET` in the production host's environment, ready for when the anchor fee is switched on. Doctor's **Fee wallet** row says whether it's needed.

## 4. WhatsApp codes: dropped, click approvals only

The founder's Twilio account was flagged inactive and they cannot sign in, so WhatsApp delivery is off until that is resolved. Every workspace approves the second way, which was always available:

- An approver clicks **Approve**.
- Maker-checker applies when **Require dual approval** is on and the amount is at or above the threshold: a second person must approve.

What changed in code (2026-09-26):

- In production, with Twilio not configured, WhatsApp approvals **cannot be switched on** (`whatsappDeliveryMissing()` in `lib/server/whatsapp.ts`, asked first by `whatsappApprovalsReady`).
- **Why:** a workspace in WhatsApp mode needs a delivered code for every payment and every settings save, including the save that switches WhatsApp mode off. Without delivery it would be locked out.
- **Known gap:** a workspace already in WhatsApp mode when Twilio goes away still cannot switch itself off. None should exist, because verifying a number needs a delivered code and Twilio never worked in production. If one ever does, an operator has to reset it directly: `update org_settings set whatsapp_enabled = false where org_id = '<org>'`. A staff-console action for this is not built.
- **To bring WhatsApp back:** resolve the Twilio account, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (and the template `TWILIO_WHATSAPP_CODE_CONTENT_SID`) on the server, and check that doctor's **WhatsApp (Twilio)** row reads ok.

## 5. Passkey domain: `splashz.xyz`, and why

**Decision:** production sets `PASSKEY_RP_ID=splashz.xyz`, the root domain. The app runs on `v1.splashz.xyz` today.

**Why the root domain and not `v1.splashz.xyz`:**

1. **A passkey is bound to one domain (its WebAuthn "relying party ID").** Browsers offer it only on that domain and its subdomains, never anywhere else.
2. **In Splash the passkey is also the admin's wallet.** The Sui address that receives USDC invoice payments and sends USDC transfers is derived from the passkey's public key. So the relying party ID effectively fixes every admin's wallet address.
3. **The domain has to outlive `v1.`.** If passkeys were bound to `v1.splashz.xyz`, moving the app to `app.splashz.xyz` later would strand every passkey:
   - admins would need new passkeys, which means new wallet addresses;
   - money at the old addresses could only be moved from `v1.splashz.xyz`.

   Bound to `splashz.xyz`, the same passkeys work on `v1.`, `app.` and any later subdomain.
4. **It has to be set before the first real passkey.** Changing it afterwards has the same effect as point 3.

**`app.splashz.xyz` was not created.** This decision doesn't need it. When production moves there:
- add the domain at the host;
- set `NEXT_PUBLIC_APP_URL=https://app.splashz.xyz`;
- leave `PASSKEY_RP_ID=splashz.xyz` as it is. Existing passkeys keep working.

Doctor's **Passkey domain** row fails if the relying party ID doesn't match the app's host. For example, `other.example` on `v1.splashz.xyz`, or `localhost` in production.

### The main admin's passkey (yours to do)

The founder hands this to you: the passkey was not created, partly because the WhatsApp half of the approval setup is gone.

1. Set `PASSKEY_RP_ID=splashz.xyz` in production and deploy.
2. Doctor or `/admin/go-live` shows **Passkey domain: ok**.
3. The main admin (the workspace's first admin) signs in on `https://v1.splashz.xyz`, goes to **Settings → Security** and clicks **Set up an approval signer**. Save the passkey to a synced password manager (Google Password Manager or iCloud Keychain), so losing one device doesn't lose the wallet. Nobody, Splash included, can recover it.
4. Note the Sui address the page shows. That is the Splash wallet. Send it about 1 SUI for gas.
5. On another device, use **Restore a passkey on this device**, not "Set up". Setting up again creates a new address.

## 6. Rehearsal, then the first real transfer

On 2026-09-26, `npm run rehearse:usdc -- --amount 1` passed **7/7 on Sui mainnet**, with the real fee wallet as the fee leg:

- the transaction built from real coins and dry-ran successfully;
- Splash's check confirmed recipient +1.00 USDC, fee wallet +0.008 USDC, sender −1.008 USDC, and nobody else's USDC moved;
- a quote one micro-USDC off was refused.

Nothing was signed or sent.

**Left, after step 5:**

```bash
npm run rehearse:usdc -- --sender <the main admin's passkey address> --amount 1
```

With `--sender` it also confirms your balances didn't change. Then send **1 USDC for real** from Send USDC to a wallet you control, and check it in Wallet activity and the CSV export.
