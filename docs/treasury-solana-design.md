# Treasury on Solana: Ondo tokenized stocks and ETFs

Status: design only (v2 brief section 7). Nothing here is built in this
repository, and nothing ships until every gate in "Before anything is built"
is met. The feature sits behind `FEATURE_ONDO_STOCKS`, which is **off** and
stays off.

## What it is

A business that holds USDC in its Splash Wallet on Sui can choose to hold
part of its treasury in Ondo's tokenized stocks and ETFs, which live on
Solana. The USDC moves from Sui to Solana by Circle's CCTP V2, lands in a
Squads multisig on Solana that belongs to the business, and is used there to
buy and later sell the Ondo tokens. The proceeds come back to Sui the same
way.

It is the third treasury option, after Ondo USDY on Sui and Halogen funds by
referral (decision D9). Like those, Splash prepares and shows; the
business's owners sign.

## Before anything is built

All four, in writing, before a line of code:

1. **Mainnet payments are live.** The Sui payment path (brief sections 3 to
   5) runs on mainnet with real businesses, and the human mainnet steps in
   `docs/MAINNET-CHECKLIST.md` are done. Treasury on Solana is not a reason
   to go to mainnet early.
2. **SC legal advice.** Advice from Malaysian counsel on whether offering,
   showing or routing orders for tokenized stocks and ETFs to a Malaysian
   business is a regulated capital-market activity under the Securities
   Commission Malaysia's rules, and what Splash may say and do as a software
   provider. The wording on any screen follows that advice.
3. **Ondo eligibility for Malaysia.** Ondo confirms that a business
   incorporated in Malaysia can hold and redeem its tokenized stocks and ETFs,
   which checks Ondo runs on the holder, and whether the Squads vault address
   (not a person) is an acceptable holder.
4. **Sky signs off** on this document, the route and the copy.

Until then the flag is off in every environment, including staging.

## The flag

- `FEATURE_ONDO_STOCKS`, default **off**. When it is added it is read in one
  place, like the other provider flags, and in production runtime mode
  (`lib/server/runtime-mode.ts`) an unset or unconfigured flag fails closed:
  no screen, no quote, no route.
- Off means the option does not appear at all. It is not shown as "Pilot
  access" or teased on the landing.
- The flag only shows the option. Every gate above is also checked on the
  server for each business (an eligibility record from Ondo, a legal-approval
  record), so turning the flag on alone moves nothing.

## The wallet on Solana: a Squads multisig with the same signers

Decision D1 makes the business's Splash Wallet a Sui multisig whose signers
are its members. On Solana the business gets **its own Squads v4 multisig**,
created for it and owned by it:

- **The same signers.** Its members are the business's own signers from the
  Sui multisig, each with a Solana key of their own, and its threshold is the
  Sui wallet's: 2-of-N by default, 1-of-1 only when the owners have recorded
  that choice. Adding or removing a signer on Sui prompts the same change on
  Solana, and nothing moves while the two disagree.
- **Splash is never a member.** The vault is autonomous (`configAuthority`
  null), so no one outside the members can change it. Splash has no key to it.
- **Reuse the splash-solana patterns.** The separate `splash-solana` repo
  already builds this: `lib/solana/squads.ts` (autonomous Squads v4 vaults,
  membership validation that refuses any Splash key, a payments vault at index
  0 and a treasury vault at index 1, proposals, approvals and execution),
  `lib/solana/kora.ts` (a sponsored fee payer, so the business never holds
  SOL, kept out of every vault message), and `lib/solana/device-key.ts` (a
  member's key on their device). Treasury on Solana uses the treasury vault
  (index 1).
- **Open question for Sky:** members on Sui sign with passkeys. Squads v4
  members are Solana (ed25519) keys, so a member's Solana key is a separate
  device key, as in splash-solana. Whether a passkey can sign for a Solana
  member directly is not settled here.

The Solana code does not come into this repository: `check:builds` fails the
lint if Solana packages land here. It lives in splash-solana (or a service
built from it), and this app talks to it over an API.

## Moving USDC: CCTP V2 only

- **Sui to Solana.** The owners approve a treasury move on Sui. The approved
  transaction burns the USDC from the business's Sui multisig with CCTP V2,
  with the destination set to Solana and the mint recipient set to the USDC
  token account of the business's Solana treasury vault. When Circle's
  attestation is ready, the Solana side receives the message (the sponsored
  fee payer pays for it) and the USDC is minted straight into that vault.
- **Solana to Sui.** The reverse: a vault proposal, signed by the members,
  burns USDC on Solana with the Sui wallet as the mint recipient.
- **USDC only, CCTP V2 only**, as for cross-chain recipients (D5) and D13.
  Package and program IDs, and the CCTP domain numbers for Sui and Solana,
  come from Circle's official supported-chains page or from Circle directly,
  not from older docs or READMEs.
- Splash never holds the USDC in between. The burn and the mint name the
  business's own addresses on both chains (D3).

## Buying and selling the Ondo tokens

- The order is a proposal on the business's Squads treasury vault: which
  token, how much USDC, the price shown, and how long that price holds. The
  members sign it; Zeke may prepare one, never sign one.
- How the order is filled (minting and redeeming with Ondo, or a swap through
  a Solana venue) is chosen once Ondo confirms eligibility and the legal
  advice is in. This document assumes neither.
- The holding view reads the vault's balances from chain. Values shown are
  the token's own published price at a time that is shown with it, never a
  projection dressed as a balance.
- These tokens are labelled **not Shariah-screened**, as USDY is labelled not
  Shariah (D9), unless a screening is obtained and named.

## What the business sees

- A third treasury card, only when the flag is on and the business passes
  every gate.
- Each move shows the route in plain words (Sui to Solana by CCTP V2, then the
  purchase), the time each step takes, every fee, and who signs.
- A receipt for each leg: the Sui burn, the Solana mint, the order, and the
  way back, so the business has a record an auditor can follow across both
  chains.

## Records and controls

- Every leg is an entry in the per-payment controls-evidence export (D12):
  who approved, what was approved, and the on-chain references.
- Rate limits and amount caps per business, set by the owners, as for
  spending rules (D2). Above the second-approval threshold a second owner
  signs.
- An attestation that never arrives, or a mint that does not land, is shown
  as stuck with the step it stopped at and what the owners can do; the app
  never reports a move as done before the vault's balance shows it.

## Not in this phase

Building any of it; adding Solana or Ondo packages to this repo; turning the
flag on anywhere; naming Ondo or any other partner in shipped copy before
an agreement is signed (`SIGNED_PARTNERS`, section 3.9).
