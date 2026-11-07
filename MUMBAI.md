
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
| Refunded, zero fee | payer **+2.000000 USDC**, fee recipient unchanged at 0.003000 |
| Commitment | `0x2b0f0602b2e293b6904a809853700a0ceb6fb7e72f434d1c7e5978312fba44a5` |

**Payment A — the acknowledgement travels.** The same proof, carried by
Chainlink CCIP 2.0 from Ethereum Sepolia to Arc.

| Step | Link |
| --- | --- |
| Sender (Sepolia) | [`0xd01a1665…8F3Ef6`](https://sepolia.etherscan.io/address/0xd01a1665f1382a22857C46668cFdB8C5048F3Ef6) |
| Acknowledgement sent | [`0x26127770…b0764`](https://sepolia.etherscan.io/tx/0x26127770435be52529296d21a8e2c0434dc80ab64677fc613e33c5d5050b0764) |
| CCIP message | [`0xa07b3722…95c6e5`](https://ccip.chain.link/msg/0xa07b3722e48b94dcb0ff411494cbc365367e890d86bdb6065d0701ca4295c6e5) |
| Escrow trusts the sender | [`0xd34d3677…fd8ef2`](https://explorer.testnet.arc.io/tx/0xd34d3677cf6a1c4f3531931048f14ae588c6b56f69255e6b5d3e5d5cf2fd8ef2) |

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

### A payment settled on Whitechain

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
