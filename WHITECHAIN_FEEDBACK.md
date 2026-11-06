# Whitechain feedback

Notes from building `SplashInvoice`, a USDT invoice checkout where the merchant
is paid immediately and the processor's fee waits for a compliance proof.
6–7 November 2026.

## What worked well

**EIP-3009 on the official USDT is the right primitive for checkout.** The
customer signs `transferWithAuthorization` and a relayer submits it, so a
first-time customer needs no WBT to pay an invoice. For a payments company that
is the difference between a checkout that converts and one that does not: asking
a buyer to acquire a gas token before they can pay is the single biggest drop-off
in onchain commerce. Having `permit` **and** 3009 on the same token meant we did
not have to choose between an approve-then-pull flow and a signed transfer.

**6 decimals matching the USDT people already know** removed an entire class of
display bug. We have been bitten elsewhere by a chain exposing the same balance
at two different decimal scales.

## What cost us time

**Two testnet RPC hosts, two different chains, nearly identical names.** This
cost us the most time of anything in the event, so it is the first thing we
would change.

```
rpc.testnet.whitechain.io    chainId 1874    the real testnet
rpc-testnet.whitechain.io    chainId 2625    something else entirely
```

The hyphenated host answers, reports a plausible chain id, and serves blocks —
it just is not the chain the faucet, the explorer and the docs are about. On it,
the official USDT address has no code and faucet WBT never arrives. Both
symptoms read as "the token is mainnet-only" and "the faucet is broken", and we
wrote both of those conclusions down before discovering neither was true.

Everything else in the ecosystem is consistently under `*.testnet.whitechain.io`
— `faucet.`, `explorer.`, `rpc.` — so the hyphenated host is the odd one out.
Either retiring it, or having it answer `eth_chainId` with something obviously
not-testnet, would save the next team several hours. A line in the docs saying
"the testnet is chain 1874; if you see 2625 you are on the wrong host" would
do it on its own.

**Two tokens both called USDT.** The official token is
`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` ("Tether USD", 6 decimals, permit
and EIP-3009). The Portal bridge delivers `USDT.e` at `0xaa79…8f46`, which is a
different contract. A developer who bridges USDT to test a USDT integration ends
up holding the token their integration does not accept, and nothing in the
bridge flow warns them. Our contract hard-codes the official address at
construction for this reason. A prominent note on the bridge page, or a different
display symbol for the bridged asset, would save that hour.

**The faucet's rate is documented inconsistently.** The docs say 0.5 WBT per 24
hours; the event flyer says 2. When you are planning an overnight build around
"can I afford to redeploy", that gap matters. We planned for 0.5.

**Testnet gas-token scarcity is the bottleneck for exactly the flows you want
built.** The gasless-checkout story is the compelling one, but building it still
needs a funded relayer, and the relayer is where the WBT goes. A relayer-specific
faucet, or a sponsored-transaction endpoint for testnet, would make this class of
app much easier to demo.

## Deployed

| | |
| --- | --- |
| `SplashProofRegistry` | `0xF2cc98A712Da800b73F000075d41276B28D74ec6` |
| `SplashInvoice` | `0x27e6cC8574deACa4B30A7A97e24fE11C209eCD95` |
| against official USDT | `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` |

The registry holds proofs from both rails: the Arc escrow settlement and the
invoice, 2 entries and 0.018 USDC of fees, each row naming the chain and
transaction it came from.

## What we built

An invoice contract with the processor's incentive inverted.

- `createInvoice(invoiceId, amount, dueAt, travelRuleCommitment)` — the merchant
  raises it; the fee is fixed at creation and can never grow.
- `payWithAuthorization(...)` — a relayer submits the customer's EIP-3009
  signature. The merchant receives its **net immediately**. Only the fee stays in
  the contract.
- `recordProof(invoiceId, commitment)` — a Splash attestor records the
  travel-rule proof and the fee is released. This is the only path that pays us.
- `forfeitFee(invoiceId)` — if no proof arrives inside the window, the held fee
  goes to **the merchant**, not back to us. Callable by anyone, so the merchant
  never depends on us to collect it.

The merchant's money is never held hostage to anything the processor does. The
only thing at risk from our failure to produce a proof is our own fee.

We check the balance delta after `transferWithAuthorization` rather than trusting
the return, so a partially honoured authorisation reverts instead of shorting the
merchant. Fee ceiling is 1%, the same ceiling our Sui contracts enforce; the demo
runs at 15 bps.

11 tests, including the forfeit path and a fee fuzz over the full amount range.

## Stated plainly

A Splash attestor records the proof. That is an attestation, not a consensus
guarantee, and we do not describe it as trustless. The worst a dishonest attestor
can do is take a fee it did not earn, capped at the fee. Customer and merchant
funds are never exposed to it.
