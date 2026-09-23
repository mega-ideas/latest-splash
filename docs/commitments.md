# Commitments: what an event carries instead of the payment

`splash_core` publishes immutable. An event struct's fields freeze at publish,
and until WS5 six of them carried the payment in cleartext: who paid whom, how
much, in what currency, at what rate, against which beneficiary reference.
Every one of those events now carries a 32-byte commitment instead.

This document is the specification. `lib/evidence/commitment.ts` implements
it, `tests/event-privacy.test.mjs` reproduces the vectors at the bottom, and
`scripts/verify-commitment.mjs` checks a settlement against its events.

## The rule

```
commitment = blake2b256( DOMAIN_TAG || bcs(payload) || salt )
```

- `blake2b256` is BLAKE2b with a 32-byte digest and no key, the same function
  as `sui::hash::blake2b256`.
- `DOMAIN_TAG` is the ASCII bytes of the tag, with no length prefix. No tag is
  a prefix of another; the test asserts this over the tag table.
- `bcs(payload)` is the BCS encoding of the payload struct below, in exactly
  the field order listed. A `String` and a `vector<u8>` encode identically
  (ULEB128 length, then bytes).
- `salt` is 32 bytes from the operating system's CSPRNG, drawn once per
  payment. It is mandatory: amounts are small numbers and addresses are
  public, so without it a commitment over them is a lookup table.
- The result is always 32 bytes. Move asserts the length
  (`payment_intent::E_BAD_COMMITMENT` = 420, `receipt_v2::E_BAD_COMMITMENT` = 804)
  and otherwise treats the bytes as opaque.

Move never sees the payload or the salt. Both live only inside the Seal
bundle (`splash.settlement-evidence.v2`, field `settlement.commitment`), and
the salt is never logged or emitted anywhere. Whoever the Seal policy admits
to the bundle can recompute the commitment and check it against the chain;
nobody else learns anything from the 32 bytes.

## Domain tags

| Tag | Family | Carried by |
|---|---|---|
| `splash:payment:v1` | one payment intent | `IntentCreated`, `IntentConfirmed`, `IntentCanceled`, `SettlementAnchored`, `PayoutApproved`, `PayoutApprovalConsumed` |
| `splash:receipt:v1` | one minted receipt | `ReceiptIssued` |

The tag is per commitment family, not per event. Every lifecycle event of one
payment carries the same 32 bytes, for two reasons. An intent can be expired
by anyone after its window, and a stranger holds no salt, so the event can
only carry what the intent already stores. And a second hash over a value
that is already salted and unpredictable hides nothing more: the events of
one payment are linked by `intent_id` regardless. Master Prompt v3 asked for
a per-event tag; this is the deliberate deviation, and it is Sebastian's to
overrule. Deriving `blake2b256(EVENT_TAG || commitment)` on chain per event is
a small change if he prefers it.

## Payload: `splash:payment:v1`

BCS struct `PaymentCommitmentPayload`, fields in this order:

| # | Field | BCS type | Meaning |
|---|---|---|---|
| 1 | `sender` | `address` | the address that opens and settles the intent |
| 2 | `recipient` | `address` | the on-chain recipient of the settlement coin |
| 3 | `beneficiary_ref` | `vector<u8>` | the verified counterparty reference, UTF-8; empty on the simple path |
| 4 | `amount` | `u64` | minor units of the settlement asset, as the intent stores it |
| 5 | `currency` | `String` | the settlement asset, e.g. `0x2::sui::SUI`; empty when the path carries none |
| 6 | `corridor` | `String` | the corridor tag, e.g. `MY-PH`; empty when the path carries none |
| 7 | `target_currency` | `String` | the payout currency, e.g. `PHP` |
| 8 | `fx_rate_usd_local` | `u64` | USD to local rate scaled by 1e6, as the intent stores it |

## Payload: `splash:receipt:v1`

BCS struct `ReceiptCommitmentPayload`, fields in this order:

| # | Field | BCS type |
|---|---|---|
| 1 | `receipt_id` | `String` |
| 2 | `sender` | `address` |
| 3 | `recipient` | `address` |
| 4 | `amount_usd` | `u64` |
| 5 | `target_currency` | `String` |
| 6 | `target_amount` | `u64` |
| 7 | `fx_rate_usd_local` | `u64` |
| 8 | `tx_digest` | `String` |

## What an event carries now

| Event | Fields |
|---|---|
| `IntentCreated`, `IntentConfirmed`, `IntentCanceled` | `intent_id: ID`, `commitment: vector<u8>`, `status: u8`, `timestamp_ms: u64` |
| `SettlementAnchored` | the same four, plus `content_hash` and `walrus_blob_id`: a ciphertext hash and a Walrus blob id, which bind the settlement to its evidence |
| `PayoutApproved` | `approval_id`, `business_account_id`, `intent_id`, `approver`, `maker`, `commitment`, `authority_epoch`, `expires_at_ms` |
| `PayoutApprovalConsumed` | `approval_id`, `business_account_id`, `intent_id`, `approver`, `commitment`, `consumed_at_ms` |
| `ReceiptIssued` | `receipt_object`, `receipt_id`, `commitment`, `settled_at`, `tx_digest`, `business_account_id`, `minter` |

`status` is the intent's status constant: pending 0, confirmed 1, expired 2,
canceled 3. A canceled event's status is its reason.

Three more events lost a field for the same reason, found by the meta-test
rather than named in the prompt: `ApplicationReceived` no longer carries the
company registration number or the KYB pointer, `BusinessVerified` no longer
carries the risk score, and `DailyCapChanged` no longer carries the ceiling.
All three values stay on the object.

## Where the salt lives

1. `lib/server/composed-payment.ts` draws the salt, builds the payload, computes
   the commitment, and opens the intent with the 32 bytes.
2. The salt and the payload go into the evidence bundle beside the commitment,
   the bundle is sealed, and the ciphertext hash is anchored.
3. Nothing between those two steps writes the salt anywhere else. The
   settlement layer (`lib/server/sui-settlement.ts`) does not have the word in
   it, and the test checks that.

## Verifying a settlement

```bash
node --experimental-strip-types scripts/verify-commitment.mjs --bundle decrypted-bundle.json --digest <tx digest> --rpc https://fullnode.testnet.sui.io:443
```

The script recomputes the commitment from the bundle's payload and salt,
checks it against the commitment the bundle claims, and then against every
lifecycle event in the transaction. It exits 0 only when every event
matches, and it never prints the salt. `--events <file>` takes the events as
a JSON array instead of fetching them.

## What this does not hide

The base-layer coin transfer still shows sender, recipient and amount. This
removes Splash's business metadata from the event stream, not the transfer.
Confidential transfers stay quarantined under the four-gate decision in
SECURITY.md. And the `PaymentIntent`, `ReceiptV2` and `SettleReceipt`
objects still store the same fields in cleartext; reducing what the objects
hold is a separate decision, recorded in SECURITY.md for Sebastian.

## Test vectors

`tests/event-privacy.test.mjs` recomputes every vector below from its
payload and salt and compares it to `commitmentHex`. The salts here are
fixed for reproducibility; a real salt never is.

```json
{
  "vectors": [
    {
      "name": "payment, every field set",
      "tag": "splash:payment:v1",
      "payload": {
        "sender": "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        "recipient": "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
        "beneficiaryRef": "counterparty:vendor-001",
        "amount": "1000",
        "currency": "0x2::sui::SUI",
        "corridor": "MY-PH",
        "targetCurrency": "PHP",
        "fxRateUsdLocal": "56000000"
      },
      "saltHex": "1111111111111111111111111111111111111111111111111111111111111111",
      "payloadBcsHex": "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b017636f756e74657270617274793a76656e646f722d303031e8030000000000000d3078323a3a7375693a3a535549054d592d504803504850007e560300000000",
      "commitmentHex": "d81dc78043e94a3f49bb8a082e300942409291e78aecbe8596e20b3df26beda4"
    },
    {
      "name": "payment, the simple path (no beneficiary reference, no corridor)",
      "tag": "splash:payment:v1",
      "payload": {
        "sender": "0x0101010101010101010101010101010101010101010101010101010101010101",
        "recipient": "0x0202020202020202020202020202020202020202020202020202020202020202",
        "beneficiaryRef": "",
        "amount": "20000000",
        "currency": "0x2::sui::SUI",
        "corridor": "",
        "targetCurrency": "PHP",
        "fxRateUsdLocal": "56420000"
      },
      "saltHex": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "payloadBcsHex": "0101010101010101010101010101010101010101010101010101010101010101020202020202020202020202020202020202020202020202020202020202020200002d3101000000000d3078323a3a7375693a3a5355490003504850a0e65c0300000000",
      "commitmentHex": "8bd9f379605699b6bfdb15ea7d954e5fd228899c411f1d12eec2129ce1e03193"
    },
    {
      "name": "payment, same payload as the first under a different salt",
      "tag": "splash:payment:v1",
      "payload": {
        "sender": "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        "recipient": "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
        "beneficiaryRef": "counterparty:vendor-001",
        "amount": "1000",
        "currency": "0x2::sui::SUI",
        "corridor": "MY-PH",
        "targetCurrency": "PHP",
        "fxRateUsdLocal": "56000000"
      },
      "saltHex": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "commitmentHex": "ff3f6627c204a1ebd55182a9b7f5d38444313b7a4925850f3189a42cadd1c2ee"
    },
    {
      "name": "receipt",
      "tag": "splash:receipt:v1",
      "payload": {
        "receiptId": "rcpt-001",
        "sender": "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        "recipient": "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
        "amountUsd": "1000",
        "targetCurrency": "PHP",
        "targetAmount": "56000",
        "fxRateUsdLocal": "56000000",
        "txDigest": "digest"
      },
      "saltHex": "1111111111111111111111111111111111111111111111111111111111111111",
      "commitmentHex": "89ad271d1ed8ffd5a4f2dab6a773fae8f1375a389198d968c896d204b76a36aa"
    }
  ]
}
```
