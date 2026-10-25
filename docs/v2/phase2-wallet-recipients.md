# Wallet recipients — v2 Phase 2 §4.7

Status: built 25 Oct 2026 on `v2/phase2-backend` (migration 0047). Brief:
`SPLASH_SUI_V2_PROMPT.md` §4.7. Decisions: D3, D5, D6, D13, and Sky's
decisions of 24 and 25 Oct 2026 (owners' own changes are instant; staff may
ask owners to approve).

Code:
- `lib/recipients/wallet-recipients.ts`: the three kinds, their checks, the
  ownership-proof message, what the Move side is given (`moveDeliveryOf`).
- `lib/server/wallet-recipients.ts`: saving, the ownership proof, the
  payment gate (`walletDeliveryGate`).
- `lib/payments/cctp-receipts.ts`: reading Circle's message for a Sui burn
  and a mint's receipt on an EVM chain.
- `lib/server/cross-chain-transfers.ts`: the cross-chain receipt.
- `lib/server/wallet-recipients-deps.ts`: the live wiring.
- Routes: `POST /api/recipients` with `deliveryKind`,
  `GET|POST|DELETE /api/recipients/[id]/ownership-proof`,
  `GET|POST /api/ownership-proofs/[token]` (public, the supplier's side),
  `GET|POST /api/wallet/payments/[ref]/cross-chain`.

Tests: `tests/wallet-recipients-v2.test.mjs` (PGlite, no network), with
additions to `tests/compliance-payment-gates.test.mjs`,
`tests/controls-evidence.test.mjs` and `tests/spend-rules.test.mjs`.

## The kinds

Every recipient now says how it is paid (`suppliers.delivery_kind`). Each
kind's columns are required for it and empty for the others; the table
checks this, and each check is written so a NULL cannot make it pass.

| Kind | What is kept | Paid as (Move) | SpendPolicy tag |
|---|---|---|---|
| `BANK` | as before | `BANK_PAYOUT` (4), through the payout route | a beneficiary commitment |
| `EXCHANGE` | the exchange (Hata, PDAX, Tokocrypto, Bitkub: `TRAVEL_RULE_EXCHANGES`), the deposit address, its network (Sui only) | `EXCHANGE` (2) | `EXCHANGE`, only for a saved exchange account |
| `SELF_CUSTODY` | the address, the wallet app as a label, the proof state (`unproven`, `proven`, `revoked`) | `WALLET` (1), only once proven | `WALLET`, only with a live proof |
| `CROSS_CHAIN` | the chain, its CCTP domain, the address as that chain writes it, CCTP's 32-byte mint recipient | `CROSS_CHAIN` (3), the owners' multisig only | none: never on a policy |

Every kind also carries the supplier's business details: registered name,
registration number, country, registered address and city (postcode and an
email for the proof link are optional). The Travel Rule message, the
sender-declaration pack and the controls evidence are built from them. They
are the paying business's words about its supplier.

Checks, before anything is stored:
- **Exchange.** The exchange is one of the four; the deposit address is a
  Sui address (an EVM address is refused, never padded); its network is
  Sui, because Splash pays USDC on Sui and the declaration and the Travel
  Rule message both say so. An exchange is named in copy only once its
  agreement is signed (`SIGNED_PARTNERS`); otherwise its role.
- **Self-custody.** A Sui address. The wallet app is Slush, MetaMask (Sui
  Snap), Backpack or Other, and decides nothing. D5 also names Phantom; it is
  not offered because Phantom ended Sui support and the table has refused it
  since migration 0020.
- **Cross-chain.** USDC only. Ethereum, Base, Arbitrum, OP Mainnet, Polygon
  PoS, Avalanche and Solana: CCTP V2 chains Circle lists with USDC that
  Splash can also screen. An EVM address passes its EIP-55 checksum when it
  is mixed case and becomes the left-padded mint recipient; a Solana
  recipient must be the supplier's USDC token account, and the business
  confirms that is what it gave (a wallet key looks the same and loses the
  funds). Sui itself is refused (it is not cross-chain), and so are chains
  Splash does not pay (Stellar, Starknet).

Saving (`createWalletRecipient`):
- The address is screened for this business by the server's provider
  (`screenRecipient`, kind `exchange_recipient`, `wallet_recipient` or
  `cross_chain_recipient`) before anything is saved. A BLOCK is refused
  (403) and not saved. With no provider in production the recipient is
  saved with no verdict, and the payment gate refuses it until it is
  screened (no verdict is made up).
- One address is one recipient in a business: a second recipient at the
  same Sui address, whatever its kind, is refused (`recipient_exists`), so
  which supplier a payment goes to is never guessed. Cross-chain recipients
  are unique per business, chain and address in the table too.
- The org comes from the session (`recipientRoute`:
  `requireSessionAccount`, own membership); owners and staff may add
  recipients, viewers may not. Another business may save the same address
  for itself; neither sees the other's.

## The ownership proof (self-custody)

D5(b): no payment to a wallet the supplier holds until the supplier proves
it holds it.

1. An owner or staff member asks for the link
   (`POST /api/recipients/[id]/ownership-proof`). Splash makes a random
   32-byte token (the link, `{NEXT_PUBLIC_APP_URL}/wallet-proof/<token>`) and
   a random 32-byte nonce, and keeps the token only as its SHA-256. The link
   is returned to whoever asked, and emailed to the supplier when its email
   is on file. Any link still open for that recipient is replaced.
2. The supplier opens it (`GET /api/ownership-proofs/[token]`, public, limited
   per network address) and sees the fixed message:

   ```
   Splash wallet ownership proof

   I control this wallet. I ask that payments to me be sent to it.

   Address: 0x…
   Business that holds this wallet: <supplier's registered name>
   Business that will pay it: <paying business's registered name>
   Nonce: <64 hex>
   Expires: <ISO time, 72 hours after the link was made>

   Signing this message moves no money and gives no one access to the wallet.
   ```

3. The supplier connects the wallet and signs it as a Sui personal message
   (`POST /api/ownership-proofs/[token] { signature }`). The challenge is
   used up first, by a compare-and-set on an unused, unexpired row, so a
   link is good for one try and its nonce for ever; then the signature over
   the stored message is checked against the stored address (any scheme Sui
   verifies; zkLogin through the chain). Only then is the proof recorded in
   `wallet_ownership_proofs` (the evidence kept as a hash) and the recipient
   marked `proven`. If the recipient's address changed after the link was
   made, nothing is recorded.

A wrong signature, a used, replaced or expired link, or a signature of
another link's message proves nothing. The page shows only the address, the
message, the expiry and the link's state: no business id.

Withdrawing a proof (`DELETE …/ownership-proof`, owners only; or removing
the recipient) marks it `revoked`, withdraws open links, and through
`revokeOwnershipProof` cancels any spending-rule request still collecting
signatures that would tag the address WALLET. A recipient already on a
SpendPolicy stays there until the owners remove it (the policy is the
multisig's), but the owners' own payments and second approvals to it stop at
the gate below.

The same proof is the off-chain gate for the WALLET tag (§4.2): a SpendPolicy
recipient is tagged WALLET only while this business holds a live proof for
it.

## The gate a payment passes

`walletDeliveryGate`, after the screening gate, when a wallet payment, an
owners' payment of an open intent, or a second approval is opened, and again
before every signature (`paymentBeforeSign`):

- kind `WALLET` (1): this business's one saved `SELF_CUSTODY` recipient at
  the address, `proven`, with a live proof row; otherwise
  `recipient_not_saved`, `recipient_ambiguous` or `ownership_not_proven`;
- kind `EXCHANGE` (2): this business's saved `EXCHANGE` recipient;
- an address saved as the other kind is refused (`kind_mismatch`), so
  declaring the other kind avoids neither the proof nor the Travel Rule;
- kind `SPLASH_BUSINESS` (0) is the chain's to check (the address registry
  derives it); a bank payout (4) goes through the payout route; a
  cross-chain payment (3) is never a payment on Sui (`wrong_pay_path`).

The older per-person send lane (`lib/server/stablecoin-send.ts`, a member's
own passkey wallet) follows the same rule at its quote: a wallet the
supplier holds only once `proven`, and an exchange account not at all
(`exchange_from_business_wallet`: it is paid from the business wallet, where
its Travel Rule message goes first). The quote is the lane's gate; a proof
withdrawn in the minutes between a quote and its submission is not
re-checked there.

The EXCHANGE tag on a SpendPolicy is given only to a saved exchange account
of this business (`exchange_not_saved`), through `OwnershipGate.savedExchanges`.

The exchange of a Travel Rule message and of a sender-declaration pack is
now the saved exchange account's own: a request naming another is refused
(`exchange_mismatch`), a wallet the supplier holds is not an exchange account
(`not_an_exchange_recipient`), and only a recipient saved before this section
(with no exchange on file) still takes it from the request.

## Cross-chain payments and their receipt

A cross-chain payment is the owners' multisig path only: `splash_spend`
refuses kind 3 on every path (`E_WRONG_PAY_PATH`), the spending-rule server
path refuses it (`wrong_pay_path`), a staff member's ask refuses it, and a
cross-chain recipient has no Sui address to put on a policy. The payment
itself (`create_cross_chain_for_wallet` → `confirm_cross_chain_from_business_wallet`
→ a registered bridge adapter's burn) is still not built: no bridge adapter
is registered in `splash_core`, and the PTB builder refuses kind 3
(`cross_chain_not_built`). What the Move needs from the recipient is ready:
`moveDeliveryOf` gives the domain and mint recipient.

The receipt (`cross_chain_transfers`) records each step once and only from
its own source:

| Step | From | Refused when |
|---|---|---|
| opened | the saved `CROSS_CHAIN` recipient of this business, the amount and Circle's fee bound; once per business and intent id | another recipient, amount or fee bound for the same intent (`cross_chain_conflict`) |
| burned | the Sui transaction: this business's own executed signing request with that digest, signed by the owners' multisig; the chain shows it succeeded from that wallet and confirmed this intent under `splash_core`'s original package id | a digest no request of this business executed, a single-key request, a failed transaction, another sender, no `IntentConfirmed` for this intent |
| attested | Circle's attestation service (`GET {CCTP_IRIS_API_URL}/v2/messages/8?transactionHash=…`): a complete message from Sui to this domain, minting exactly this amount to this mint recipient, a fee no higher than the bound, any relayer, a nonce | anything else (`burn_mismatch`, logged for ops by id) |
| minted | the destination chain's own receipt (`eth_getTransactionReceipt` through `CCTP_MINT_RPC_URLS_JSON`): succeeded, and Circle's MessageTransmitterV2 on that chain logged `MessageReceived` for this nonce from Sui with this message's body | another contract, nonce, source or body; a Solana mint (not read yet: the payment stays attested) |

Forward only: a trigger refuses a step back, a replaced burn, attestation or
mint, a change to what is paid, and any delete. Each step is a
compare-and-set on the status. One burn, one message nonce and one mint
transaction per receipt (unique). The attestation is kept as Circle gave
it; the destination chain checks Circle's signatures when it mints.

Fail closed: production reads Circle only at `CCTP_IRIS_API_URL` and never
Circle's sandbox (`USE_MOCK_APIS` changes nothing); development reads
Circle's own sandbox, and a receipt attested from it is labelled
`sandbox`. A mint is read only through a configured https RPC for that
chain; without one, nothing is recorded (`mint_check_not_configured`).
Nothing here signs, relays or sends anything.

Contract addresses (Circle's EVM contracts page, read 25 Oct 2026):
MessageTransmitterV2 `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` on mainnet
chains (EDGE `0x5b61381Fc9e58E70EfC13a4A97516997019198ee`), and
`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` on testnets. The header layout
and the event are from `circlefin/evm-cctp-contracts`
`src/v2/MessageTransmitterV2.sol`.

## Not built here

- The supplier's page at `/wallet-proof/<token>` (Phase 3): the API it calls
  is built.
- The cross-chain payment PTB and the bridge adapter (above). Until then
  nothing calls `openCrossChainTransfer`; the receipt is ready for it.
- Reading a Solana mint; Circle's attestation is kept, and the mint is
  recorded once a Solana reader exists.
- An exchange deposit on a network other than Sui.
- The sender-declaration pack before a payment exists: it is per payment
  (the signing request), as §4.6 built it.
- A legacy wallet recipient (saved before this section) is now an unproven
  wallet the supplier holds: it is not paid until proven, and it has no
  supplier business details until the business adds them.
- The controls evidence does not include the cross-chain receipt yet.
