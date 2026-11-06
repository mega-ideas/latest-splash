
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

## What is not deployed, and why

`SplashInvoice` and `SplashProofRegistry` are written and tested (20 tests) but
not deployed. The Whitechain testnet faucet gives 0.5 WBT per 24 hours and our
addresses had none, and the official USDT address
`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` has no contract on testnet — it is
a mainnet address. We would rather say that plainly than show a deployment that
is not there.

The relayer reads settlements from the rail's own events rather than from our
notes, so a registry row cannot claim a payment the rail did not make. Against
the live escrow it already reads:

```
0xc92382f8…  amount 2.000000  fee 0.003000  commitment 0x9dc8d5d0d1…
```
