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

Tests: `tests/wallet-recipients-v2.test.mjs` and
`tests/cross-chain-batch-burn.test.mjs` (PGlite, no network), with
additions to `tests/compliance-payment-gates.test.mjs`,
`tests/controls-evidence.test.mjs` and `tests/spend-rules.test.mjs`.

## The kinds

Every recipient now says how it is paid (`suppliers.delivery_kind`). Each
kind's columns are required for it and empty for the others; the table
checks this, and each check is written so a NULL cannot make it pass.

| Kind | What is kept | Paid as (Move) | SpendPolicy tag |
|---|---|---|---|
| `BANK` | as before | `BANK_PAYOUT` (4), through the payout route | a beneficiary commitment |
| `EXCHANGE` | the exchange (Hata, PDAX, Tokocrypto, Bitkub: `TRAVEL_RULE_EXCHANGES`), the deposit address, its network (Sui only) | `EXCHANGE` (2), signed only once the exchange confirmed the account | `EXCHANGE`, only for a confirmed exchange account |
| `SELF_CUSTODY` | the address, the wallet app as a label, the proof state (`unproven`, `proven`, `revoked`), when and by which link it was proven, the ownership epoch | `WALLET` (1), only once proven | `WALLET`, only with a live proof |
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
  Splash can also screen. An EVM address is taken only in its EIP-55
  checksummed form (an all lower-case copy carries no checksum, so a typo
  would pass and a mint to it cannot be undone; `bad_address`) and becomes
  the left-padded mint recipient. A Solana recipient must be the supplier's
  USDC token account: the business confirms that is what it gave, and the
  server then asks Solana (`getAccountInfo`, jsonParsed, through
  `CCTP_MINT_RPC_URLS_JSON`'s `SOLANA` entry,
  `lib/server/solana-token-accounts.ts`): owned by the SPL Token program, a
  token account, Circle's USDC mint for the network, initialized. The token
  account's owner is recorded (`destination_token_owner`). Otherwise
  `solana_not_usdc_token_account`; with no RPC, or one that does not answer,
  nothing is saved (`solana_check_not_configured`,
  `solana_check_unavailable`), in every runtime. Sui itself is refused (it is
  not cross-chain), and so are chains Splash does not pay (Stellar,
  Starknet).
- **Never Splash's address, never the business's own.** An address Splash
  controls is refused at saving and at every gate
  (`splash_controlled_address`, `lib/server/splash-addresses.ts`): the
  operator (who is also the gas sponsor), the treasury, the test recipient,
  FeeConfig's fee recipient and pending recipient (read live; production
  refuses with `splash_addresses_unreadable` when it cannot name them), and,
  for a cross-chain recipient, the operator's CCTP deposit addresses. The
  business's own wallet and its members' addresses (passkey credentials,
  zkLogin identities, signers, single-signer consents, the senders of its
  signing requests and withdrawals) are refused as suppliers (`own_address`):
  a member's own wallet saved as a "supplier" is how an insider would pay
  themselves.

Saving (`createWalletRecipient`):
- The address is screened for this business by the server's provider
  (`screenRecipient`, kind `exchange_recipient`, `wallet_recipient` or
  `cross_chain_recipient`) before anything is saved. A BLOCK is refused
  (403) and not saved. With no provider in production the recipient is
  saved with no verdict, and the payment gate refuses it until it is
  screened (no verdict is made up).
- One address is one recipient in a business: a second recipient at the
  same Sui address, whatever its kind, is refused (`recipient_exists`), so
  which supplier a payment goes to is never guessed. The check and the
  insert run under a per-address transaction lock
  (`pg_advisory_xact_lock`), so two saves at once leave one recipient.
  Cross-chain recipients are unique per business, chain and address in the
  table too.
- The org comes from the session (`recipientRoute`:
  `requireSessionAccount`, own membership); owners and staff may add
  recipients, viewers may not. Another business may save the same address
  for itself; neither sees the other's.
- The older body (`POST /api/recipients` with `payoutMethod: 'WALLET'`) is
  the same save: a `SELF_CUSTODY` recipient through `createWalletRecipient`,
  the supplier's details required, owners and staff only. There is no
  second save and no attestation in place of a screening.

## The owners' approval (maker-checker)

A wallet recipient a staff member saved is not paid, and cannot be tagged on
a SpendPolicy, until an owner approves it
(`POST /api/recipients/[id]/approval`, owners only; the one who saved it
does not approve it): `recipient_not_approved` at the gate. An owner's own
save is approved by that owner. Who saved it (`created_by`), the owner who
approved it (`approved_by`, `approved_at`), and when and by which link it
was proven are kept on the recipient and named in the controls evidence
(`recipient`). Recipients saved before migration 0048 have no approval and
wait for one.

A wallet without the supplier's registered name, registration number,
address and city is not paid and gets no proof link
(`supplier_details_missing`).

Removing a recipient (`DELETE /api/recipients/[id]`) is for owners and
staff; removing one that can be paid (a proven wallet, a confirmed
exchange account: what a SpendPolicy may tag) is for owners only, as
withdrawing a proof is.

## The ownership proof (self-custody)

D5(b): no payment to a wallet the supplier holds until the supplier proves
it holds it.

1. An owner or staff member asks for the link
   (`POST /api/recipients/[id]/ownership-proof`). Splash makes a random
   32-byte token (the link, `{NEXT_PUBLIC_APP_URL}/wallet-proof/<token>`) and
   a random 32-byte nonce, and keeps the token only as its SHA-256. The link
   is emailed to the supplier. Only an owner is shown it (an owner may pass
   it on); a staff member is not, so a staff member can neither sign it
   with a wallet of their own nor spend it with a junk signature. A staff
   member's request needs the supplier's email on file
   (`supplier_email_needed`), and an email that fails closes the link at
   once (`email_failed`). Any link still open for that recipient is
   replaced.
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
   verifies; zkLogin through the chain). A check that could not be made (the
   chain was unreadable) is not a bad signature: the link is given back and
   the answer is 503 `verification_unavailable`; a signature that was checked
   and is wrong still uses the link up. Only then, in one transaction, is
   the recipient marked `proven` (with the time and the link), the challenge
   `verified`, and the proof recorded in `wallet_ownership_proofs` (the
   evidence kept as a hash), and only if the recipient is still the one the
   link was made for and no withdrawal came since: each withdrawal moves
   the recipient's ownership epoch on, and a link made in an older epoch
   proves nothing (`proof_withdrawn`). So an owner's withdrawal while a
   zkLogin signature is being checked is never undone by the check
   finishing after it. If the recipient's address changed, nothing is
   recorded (`recipient_changed`).

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
recipient is tagged WALLET only while the payment gate below would pay it as
a wallet (a live proof, an owner's approval, the supplier's details, not
Splash's or the business's own address).

## The gate a payment passes

`walletDeliveryGate`, after the screening gate, when a wallet payment, an
owners' payment of an open intent, or a second approval is opened, and again
before every signature (`paymentBeforeSign`):

- never an address Splash controls (`splash_controlled_address`) or one of
  the business's own (`own_address`), whatever is saved;
- kind `WALLET` (1): this business's one saved `SELF_CUSTODY` recipient at
  the address, with the supplier's details, approved by an owner, `proven`,
  with a live proof row; otherwise `recipient_not_saved`,
  `recipient_ambiguous`, `supplier_details_missing`,
  `recipient_not_approved` or `ownership_not_proven`;
- kind `EXCHANGE` (2): this business's saved `EXCHANGE` recipient, with
  the supplier's details, approved by an owner. Nothing checks by itself
  that a deposit address belongs to the exchange named, so the account is
  unconfirmed until the exchange's side confirmed it: a Travel Rule message
  from this business to that address at that exchange, made after the
  account was saved, that the counterparty approved (`approved`, not
  `submitted` or `awaiting_counterparty`; in production never a sandbox
  message). The first payment may be opened (its message is sent from it),
  but it is signed only once its message is approved
  (`exchange_unconfirmed`); after that, later payments follow the usual
  Travel Rule hold (§4.6);
- an address saved as the other kind is refused (`kind_mismatch`), so
  declaring the other kind avoids neither the proof nor the Travel Rule;
- kind `SPLASH_BUSINESS` (0) is the chain's to check (the address registry
  derives it); a bank payout (4) goes through the payout route; a
  cross-chain payment (3) is never a payment on Sui (`wrong_pay_path`).

The older per-person send lane (`lib/server/stablecoin-send.ts`, a member's
own passkey wallet) follows the same rule: a wallet the supplier holds only
once the gate above lets it through, and an exchange account not at all
(`exchange_from_business_wallet`: it is paid from the business wallet, where
its Travel Rule message goes first). The gate runs at the quote and again at
submission, before the approval is spent: a proof withdrawn between the two
stops the transfer.

The EXCHANGE tag on a SpendPolicy is given only to a confirmed exchange
account of this business (`exchange_not_saved`), through
`OwnershipGate.savedExchanges`, which reads the same gate.

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
compare-and-set on the status. One owners' transaction may pay several
cross-chain payments (a batch is one signature for one PTB, §5.6), so a Sui
digest may be the burn of several receipts (0056), each recorded only
because that transaction confirmed the receipt's own intent. Each receipt
takes its own Circle message of that burn: the one that mints exactly its
amount to its recipient and whose nonce no other receipt has taken; a
message nonce is unique, and a receipt that loses a race for one stays
burned for the next refresh. When none of Circle's messages is the
payment's, it stays burned while Circle still holds one unattested, and is
otherwise a mismatch. A mint is unique per chain, transaction and message
nonce (0048), so a relayer that mints several payments' messages in one
transaction is recorded for each.

Opening a receipt meets the same recipient rules as the Sui kinds, and a
burn cannot be reversed, so they are checked then: an owner approved the
recipient (`recipient_not_approved`: a staff member's save waits), the
supplier's details are on file (`supplier_details_missing`), and neither the
address nor, on Solana, the wallet that owns the token account is one Splash
controls (`splash_controlled_address`). Splash's addresses on other chains
(`FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON`) fail closed like the Sui ones: an
unreadable value refuses with 503 `splash_addresses_unreadable`, and so does
production with none set. The burn is recorded after the owners signed it,
so it is not checked again there.

A mint is checked against Circle's MessageTransmitterV2 on the network the
receipt's attestation came from: the testnet contract for a sandbox
attestation, the mainnet one for any other, whatever the server's
`SUI_NETWORK` says.

The sweep (`/api/cron/cross-chain`, every ten minutes; review B7) asks
Circle again for every burned payment, within its own business, so a lost
refresh does not leave it burned, and reports a payment burned but not
minted six hours after its burn (an ALERT line by id, and a 502) for ops to
relay its mint from the message and attestation on the receipt. A Solana
payment already attested is listed apart (`manualRelay`, a RELAY line) and
does not make the cron fail, since its mint is not read and waits for a
hand relay. The receipt
is also in the payment's controls evidence (`crossChain`). The attestation is kept as Circle gave
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

- A per-payment Travel Rule message for a rule payment (an executor paying
  under a SpendPolicy) to an address tagged EXCHANGE. The tag needs an
  exchange account the exchange confirmed once (an approved message), but an
  executor's rule payment does not pass through Splash's signing layer, so no
  message is made for it. Sky decides whether rule payments to an exchange
  are allowed at all, or need a message per payment before the tag is set.
- A mint read at a finalised block: a Base, Ethereum or other EVM mint is
  read at the latest block, so a reorg could leave a recorded mint that no
  longer exists.

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
  wallet the supplier holds: it is not paid until proven, gets no proof link
  until the supplier's business details are on file, and waits for an
  owner's approval. There is no edit route yet, so the business saves it
  again with its details.
- A memo or tag on an exchange deposit address: Splash assumes each
  exchange gives each customer their own Sui USDC deposit address. To be
  confirmed with each exchange before go-live; a shared omnibus address
  with a memo would need a memo field carried in the Travel Rule message and
  the declaration.
- A staff member's own in-limit rule payment has no server path yet, so the
  gate does not run on it; a WALLET or EXCHANGE tag stays on chain after a
  proof is withdrawn until the owners remove it (§4.2).
