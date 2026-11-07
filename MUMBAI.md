
## Proof table

Every link below is a real transaction on a public testnet. One commitment can
be followed across all of them.

**Payment C — the proof released the money.** 2 USDC escrowed on Arc, the
beneficiary recomputed the commitment from the record it holds, acknowledged
it, and the escrow paid the recipient and charged Splash's fee in the same
transaction.

| Step | Link |
| --- | --- |
| Escrow (Arc) | [`0xc536d49c…72ae34`](https://explorer.testnet.arc.io/address/0xc536d49c040c3327ee6aa72b83c8a9d31a72ae34) |
| Escrow deployed | [`0xa8d66129…d23f33`](https://explorer.testnet.arc.io/tx/0xa8d661291b43effbc8ddb7be25761f6a262919fdc406db8ce088fcf128d23f33) |
| Payment opened | [`0x97a8d0f4…5ec6f0`](https://explorer.testnet.arc.io/tx/0x97a8d0f45db7ffb17a3c689a4896c467506e925632ae5098972dcd06ca5ec6f0) |
| **Released, fee charged** | [`0x25d93b00…3462ab`](https://explorer.testnet.arc.io/tx/0x25d93b00ee8cb270145f0ce8ea0661fead66e6a912019f8bb8214d37d23462ab) |
| Commitment | `0x9dc8d5d0d1fc026cb5f53bde2d1e759274def1641c67c244649cd7cab3a0cded` |
| **Same commitment anchored on Sui** | [`9DsBLSiK…tJ3VaY`](https://testnet.suivision.xyz/txblock/9DsBLSiKhgdT9yXW8EgkRxeM1nA9tF9ZDbUweatJ3VaY) |

The Sui anchor is the audit record, written by the `audit_anchor` module Splash
already ran before this event — no new Move was written for it. One commitment,
created off chain, enforced on Arc, recorded on Sui: the same 32 bytes in all
three places.

Result on chain: recipient **+1.997000 USDC**, Splash **+0.003000 USDC**, which
is `min(maxFee, 2 USDC × 15bps)` exactly.

**Payment B — no proof, so no fee.** 2 USDC escrowed, left to expire, refunded
in full. Splash's balance did not move.

| Step | Link |
| --- | --- |
| Payment opened | [`0x76fa5c23…1ba0de7`](https://explorer.testnet.arc.io/tx/0x76fa5c2306cc9167a72c5276c5e2170b9fd7e9beba8c114cf4880cb4c1ba0de7) |
| Refunded, zero fee | [`0x14c9e5b0…032e7ff`](https://explorer.testnet.arc.io/tx/0x14c9e5b097f032e7ff) — payer **+2.000000 USDC**, fee recipient unchanged at 0.003000 |
| Commitment | `0x2b0f0602b2e293b6904a809853700a0ceb6fb7e72f434d1c7e5978312fba44a5` |

**Payment A — the acknowledgement travels.** The same proof, carried by
Chainlink CCIP 2.0 from Ethereum Sepolia to Arc.

| Step | Link |
| --- | --- |
| Sender (Sepolia) | [`0xd01a1665…8F3Ef6`](https://sepolia.etherscan.io/address/0xd01a1665f1382a22857C46668cFdB8C5048F3Ef6) |
| Acknowledgement sent | [`0x26127770…b0764`](https://sepolia.etherscan.io/tx/0x26127770435be52529296d21a8e2c0434dc80ab64677fc613e33c5d5050b0764) |
| CCIP message | [`0xa07b3722…95c6e5`](https://ccip.chain.link/msg/0xa07b3722e48b94dcb0ff411494cbc365367e890d86bdb6065d0701ca4295c6e5) |
| Escrow trusts the sender | [`0xd34d3677…fd8ef2`](https://explorer.testnet.arc.io/tx/0xd34d3677cf6a1c4f3531931048f14ae588c6b56f69255e6b5d3e5d5cf2fd8ef2) |

Every transaction that has ever touched the escrow is one of ours — three
`open`s, one `ackLocal`, one `refund`, one `setAckSender`. **None came from the
CCIP off-ramp.** The message has not been delivered at all: it is held in
verification, before execution, so our receiver has never been called. There is
nothing in the contract to fix, which is also why the local path proves the
release rule just as well.

The message is a genuine CCIP **2.0.0** message carrying
`requestedFinalityConfig 0x00000005` — block-depth finality rather than full
finality, because an acknowledgement carries no value and the money it releases
is already escrowed. At the time of writing it is still `VERIFYING`; the local
acknowledgement path (Payment C) is what proves the release rule end to end.

## The relayer

The relayer reads settlements from the rail's own events rather than from our
notes, so a registry row cannot claim a payment the rail did not make. Against
the live escrow it already reads:

```
0xc92382f8…  amount 2.000000  fee 0.003000  commitment 0x9dc8d5d0d1…
```

## The invoice rail, and one registry for both

Deployed on **Whitechain testnet (chainId 1874)**, against the official USDT
`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`, and mirrored on Sepolia.

| | Whitechain (1874) | Sepolia |
| --- | --- | --- |
| `SplashProofRegistry` | [`0xF2cc98A7…D74ec6`](https://explorer.testnet.whitechain.io/address/0xF2cc98A712Da800b73F000075d41276B28D74ec6) | [`0x27e6cC85…9eCD95`](https://sepolia.etherscan.io/address/0x27e6cC8574deACa4B30A7A97e24fE11C209eCD95) |
| `SplashInvoice` | [`0x27e6cC85…9eCD95`](https://explorer.testnet.whitechain.io/address/0x27e6cC8574deACa4B30A7A97e24fE11C209eCD95) | [`0x7805719A…789Cbc`](https://sepolia.etherscan.io/address/0x7805719AE19522422ec2B404e1f2a58A4C789Cbc) |

A correction worth recording, because it cost us hours. There are two hosts:

```
rpc-testnet.whitechain.io   chainId 2625   a different chain entirely
rpc.testnet.whitechain.io   chainId 1874   the real testnet
```

On 2625 the official USDT address has no code and the faucet's WBT never
appears, which looks exactly like "the token is mainnet-only" and "the faucet
is broken". Neither was true. The faucet, explorer and RPC all live under
`*.testnet.whitechain.io`; the hyphenated host is something else. See
`WHITECHAIN_FEEDBACK.md`.

### Both rails, one list, on Whitechain

| Registry entry | |
| --- | --- |
| Arc escrow settlement | [`0xcec2de31…4cd7b3`](https://explorer.testnet.whitechain.io/tx/0xcec2de3188003f5cb8c8f19c68f8e7351d2b5af272c832767ceb8872d44cd7b3) |
| Invoice settlement | [`0x3b87ae66…640414`](https://explorer.testnet.whitechain.io/tx/0x3b87ae668ad31a8d1eaeb6ec8aa0c9cd911aab9999e263d23079d01c5f640414) |
| `total()` | **2** proofs |
| `totalFeesRecorded()` | **0.018000** = 0.003 Arc + 0.015 invoice |

Two rails that never touch each other's money, and one list an auditor reads to
see every fee Splash earned and the proof that earned it. In production this is
Walrus; the registry is the stand-in, same shape, on a chain, checkable today.

It is a record, not a gate. Nothing in it can release or withhold anyone's
money, and no rail reads it to decide anything. A duplicate commitment is
refused so the count cannot be inflated, and every row names the chain and
transaction it came from so each can be checked against the rail itself.

### Official USDT, paid by signature, on Whitechain

The real thing: `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`, no gas token for
the customer, fee held until the proof.

| Step | Link | Result |
| --- | --- | --- |
| 25 USDT invoice raised | — | fee fixed at 0.0375 |
| Customer signs | — | EIP-3009, **no transaction, no WBT** |
| Relayer submits | — | merchant **+24.9625 at once**, 0.0375 held |
| Proof recorded | [`0xa6dd4a30…886f1c`](https://explorer.testnet.whitechain.io/tx/0xa6dd4a305e721a0d142664e8d55bc6fb473f49ffb8b76d85da2f356f3b886f1c) | **Splash paid 0.0375**, only now |

Contract: [`0x27e6cC85…9eCD95`](https://explorer.testnet.whitechain.io/address/0x27e6cC8574deACa4B30A7A97e24fE11C209eCD95).

Getting the USDT took a detour worth recording. The faucet dispenses WBT only,
and the token's `mint` is `onlyOwner`. But the chain runs a Uniswap V3
deployment with a live WWBT/USDT pool at the 0.3% tier, so we wrapped 0.5 WBT
and swapped: [`0xb7c64c99…f46589`](https://explorer.testnet.whitechain.io/tx/0xb7c64c999f8ebd0a9db620247b4b4b94329cc607bdf51aaec01bca71f4f46589).

One trap for anyone following: the token's `version()` returns an **empty
string**, but its `DOMAIN_SEPARATOR` is built with version `"1"`. We derived it
by reproducing the separator rather than trusting the getter — signing with
`""` produces a valid-looking signature the token silently rejects.

### An earlier run, with a test token

| Step | Link | Result |
| --- | --- | --- |
| Invoice raised, 50 USDT | [`0xaa1b9e62…122069`](https://explorer.testnet.whitechain.io/tx/0xaa1b9e622e28112a719346221587a600a3b20179f144f75b9adc8bd4d3122069) | fee fixed at 0.075 |
| Customer pays | [`0x99f4cd15…0f3a85`](https://explorer.testnet.whitechain.io/tx/0x99f4cd1592154b1a47c9ee5a1dbb409a8e767f2ce8fcd9a4e38f330e6b0f3a85) | merchant **+49.925 at once**, 0.075 held |
| Proof recorded | [`0x8f4ff643…2ac66e`](https://explorer.testnet.whitechain.io/tx/0x8f4ff643179627d97bd2131f649a63684f4fab6794be09eb32d50d22c02ac66e) | **Splash paid 0.075**, only now |

`SplashInvoice` for this run is
[`0x60A24A73…D33889`](https://explorer.testnet.whitechain.io/address/0x60A24A7347f9701a1bbEb998EF9878eAEcD33889),
paid through `payWithApproval`.

The official USDT at `0xcedfB561…` does carry EIP-3009 — we checked, and the
deployment at `0x27e6cC85…` points at it. We could not obtain any: `mint` is
`onlyOwner` and we are not the owner. So this run used a mintable test token
and the approval path. The gasless EIP-3009 path is the one this rail is for,
and it is demonstrated on Sepolia below with Circle's USDC, which has the same
surface. With official USDT in hand, the same contract runs it unchanged.

### The same invoice, paid by signature

Run on Sepolia with Circle's USDC, which has the same EIP-3009 surface:

| Step | Link | Result |
| --- | --- | --- |
| Invoice raised | [`0xdf54bb0f…f3145d`](https://sepolia.etherscan.io/tx/0xdf54bb0fbaf67141bd7a4d1e11769dcf77f3091db4c86c94958114aa3bf3145d) | fee fixed at 0.015, can never grow |
| Customer signs | — | EIP-3009, **no transaction, no gas token** |
| Relayer submits | [`0x2f236bf5…11f0c5`](https://sepolia.etherscan.io/tx/0x2f236bf57d627ac7b4821c838304fda2722c3f51d70d597c158716247511f0c5) | merchant **+9.985 at once**, 0.015 held |
| Proof recorded | [`0xb1363e79…74cf3b`](https://sepolia.etherscan.io/tx/0xb1363e79bd0e6b8e82e1618d26c0323e99782ad2bf4d8b85d6d08844cb74cf3b) | **Splash paid 0.015**, only now |

The customer spent no gas token and never sent a transaction. The merchant's
money was never held hostage to anything Splash did: only the fee waited, and
had no proof arrived `forfeitFee` would have sent it to the merchant, not back
to Splash.

## The treasury: where a proof-earned fee ends up

Splash charges a fee only when a travel-rule proof is recorded. Those fees
arrive in whatever the rail settled in — USDT on Whitechain, USDC on Arc —
while the treasury holds one reserve asset. Something has to convert them, and
that something is Uniswap.

| | |
| --- | --- |
| `SplashTreasury` | [`0x1c5BfC99…de1Ab6`](https://explorer.testnet.whitechain.io/address/0x1c5BfC9952B4B69cC16C309d7331639424de1Ab6) |
| Uniswap V3 `SwapRouter02` | `0xe208cC685cD95D56E8ec6DEC9816476567fc6962` |
| Pool used | [`0x5645101C…F027E3`](https://explorer.testnet.whitechain.io/address/0x5645101Ca8d2F7BaBC27b10359555767a1BdF999) — WWBT/USDT, 0.3% |

The sweep of the fee earned by the Whitechain invoice:
[`0x11f535bb…7d0b29`](https://explorer.testnet.whitechain.io/tx/0x11f535bbbe6fd138fc4b2cfc694824ecb6ec328c3569a1311b207234ff7d0b29)

```
fee wallet USDT      0.037500  ->  0
treasury reserve     0         ->  0.000512465556245838
swept[0x9dc8d5d0…]   true
```

### Why this is not just a swap

The `FeeSwept` event carries the `travelRuleCommitment` that earned the fee. So
one 32-byte value can be followed the whole way:

```
the payment  ->  the proof that released it  ->  the fee it earned
             ->  the Uniswap swap  ->  the treasury position
```

An auditor asking "where did this revenue come from" gets an answer that
terminates in a proof, not in a balance.

Three properties the contract enforces:

- **One sweep per proof.** A fee is earned once, so the sum of `FeeSwept` is
  revenue rather than revenue plus retries.
- **`minOut` is required, never defaulted.** A sweep that accepts any price is
  a sweep that can be sandwiched, and the caller is the one who knows what the
  fee was worth. A test drives the price down and checks the swap reverts.
- **It holds no customer money.** It never touches an escrow or an invoice; it
  moves fees already earned. The worst a compromised treasurer can do is sell
  Splash's own revenue badly.

The reserve is a constructor parameter, set here to WWBT. In production it is
**USDY** — Splash's ledger already prices a yield-bearing reserve
(`treasury_ledgers`, and the `swap (USDC to USDY) | redeem (USDY to USDC)`
order kinds predate this event). There is no USDY on either testnet we used, so
the demo sweeps into what exists rather than deploying a token and calling it
USDY.

### One treasury, many rails

Fees accrue one proof at a time but sweep in batches, because a treasury that
needs one transaction per fee is a treasury that quietly stops sweeping.

| | |
| --- | --- |
| `SplashTreasury` (batch) | [`0x54C58B40…02e722`](https://explorer.testnet.whitechain.io/address/0x54C58B4016FC059f36D68896b4f317e55502e722) |
| Both rails, one transaction | [`0xb29e4129…2327d1`](https://explorer.testnet.whitechain.io/tx/0xb29e41294a5490a9124513bbcf1b157c1829d942bb5697b120dff6ad452327d1) |

```
fee wallet                     0.018000 USDT  ->  0
treasury reserve               0              ->  0.000245986733001312
swept[0x9dc8d5d0…]  (Arc)      true
swept[0x2b0f0602…]  (invoice)  true
```

`sweepMany` changes the gas and nothing else. Each proof still emits its own
`FeeSwept`, so the audit trail is identical to sweeping one by one — a test
counts the events to prove it.

`minOut` stays **per proof**, never a batch total: a single total would let a
good price on one fee hide a bad one on another. A test halves the price on the
second fee only and checks the whole batch reverts with nothing marked swept.

The second fee came from a second real invoice on Whitechain
([`0x95efe8c0…b4e1eb`](https://explorer.testnet.whitechain.io/tx/0x95efe8c0d36321f7e10ad510c12331c7abfa905da9915380985488638ab4e1eb)
paid, [`0x52547185…a4c794`](https://explorer.testnet.whitechain.io/tx/0x5254718579a654dbf6feeb49cdb0b211a9a34a6e5bb37ec692548b28b7a4c794)
proof recorded) through
[`0xd736E9D9…29Ce4F`](https://explorer.testnet.whitechain.io/address/0xd736E9D99aA0EcC6Db78f36ad41597Ef7A29Ce4F),
which carries both the EIP-3009 and the approval path.
