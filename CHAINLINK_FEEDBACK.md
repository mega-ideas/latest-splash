# Chainlink feedback

Notes from building `SplashTravelRuleAck` against CCIP 2.0 on the
Ethereum Sepolia → Arc Testnet lane, 6–7 November 2026. Everything below was
checked against the live chain or the CCIP API rather than taken from docs.

## What worked well

**The lane is genuinely fast when you ask it to be.** Message
`0xdecf050f37c424f1fe471a01d2e088729215f1b096f41ec89d7c6dd61f60ac48` delivered
in **74 seconds**:

```
version                   2.0.0
deliveryTime              74000 ms
extraArgs.gasLimit        1200000
requestedFinalityConfig   0x00000005
finalityType              BLOCK_DEPTH   (finality 5)
status                    SUCCESS
onramp                    0x8dcf17f298c881A547D91ca4aA3C2AD7568C6777
offramp                   0xAB7a0743AC17D293e0A34f704367331Ec23D748f
```

Requested finality as a block depth is the single most useful 2.0 feature for
what we are building. A travel-rule acknowledgement carries no value — the money
it releases is already escrowed on the destination chain and cannot go anywhere
else — so it does not need to wait for full finality. Being able to say that *in
the message* rather than in a comment is the right shape. Our sender exposes it
as policy: `setExecutionPolicy(gasLimit, blockDepth)`, with `blockDepth = 0`
meaning "wait for finality".

**`ExtraArgsCodec` is pleasant to use.** `_getBasicEncodedExtraArgsV3BlockDepth`
is exactly the right level of abstraction, and `FinalityCodec._encodeBlockDepth`
being `bytes4(uint32(depth))` made it trivial to confirm our encoding matched a
known-good message byte for byte.

**Paying fees in the native token removed a whole class of demo failure.**
`feeToken = address(0)` meant no LINK faucet stood between a beneficiary and its
compliance duty.

## What cost us time

**`GenericExtraArgsV3` is not in `Client.sol`.** `@chainlink/contracts-ccip`
2.0.0 ships `GenericExtraArgsV2` (tag `0x181dcf10`) in
`contracts/libraries/Client.sol`, and the V3 tag (`0xa69dd4aa`) plus its helpers
live in `contracts/libraries/ExtraArgsCodec.sol`. Every example and most docs
point at `Client._argsToBytes`, so the natural path leads to V2 and a developer
building "a CCIP 2.0 integration" can ship V1/V2 args without noticing. A
`Client._argsToBytesV3` re-export, or a line in `Client.sol` pointing at
`ExtraArgsCodec`, would fix this in one commit.

**The receiver-side failure rate on this lane is high.** Of the 25 most recent
messages on Sepolia → Arc before we started, 10 failed on the receiver side.
That is survivable once you know, because you test `_ccipReceive` against a
pranked router first and give gas headroom — but the CCIP Explorer presents a
receiver revert much like a lane problem, and the distinction matters a lot when
you are deciding whether to keep waiting. Surfacing "the message was delivered;
your receiver reverted" as a distinct state would save real debugging time.

**Latency is bimodal and undocumented.** Most messages on this lane take 15–19
minutes; the one above took 74 seconds. The difference appears to be the
requested finality config, which is visible in the API response but is not
something the docs lead with. If that relationship is as direct as it looks, it
deserves to be the headline of the 2.0 migration guide: *this is the knob*.

## The Sui lane

We wanted the audit record for each payment to arrive on Sui by CCIP, which
would have made the proof's journey end to end. We could not:

- Sepolia → Sui testnet is a **1.6.0** lane, not 2.0.
- It has not delivered since **15 April 2026**.
- The 40 most recent messages addressed to Sui (August–October) never committed.

So Sui became the audit record written directly by our own script against the
Move package we already run there, and the CCIP leg is Sepolia → Arc only. We
would happily move that leg to CCIP the moment the lane is 2.0 and delivering.

One ergonomic note for the Sui path, found while preparing a canary: in
`ccip-cli` 1.16.1 the `--account` flag is silently dropped for Sui destinations.
Object ids have to be passed with `-x receiverObjectIds=[...]`. Silently is the
problem — it fails much later, somewhere unrelated.

## What we built

The acknowledgement *is* the message. A beneficiary institution holds the
travel-rule record offchain, recomputes

```
blake2b256( "splash:travel-rule:v1" || bcs(record) || salt32 )
```

and sends that 32-byte commitment over CCIP to an escrow on Arc, which releases
the principal and takes our fee inside `_ccipReceive`. An institution that never
received the record cannot produce the value, so it cannot release the money.

Most CCIP entries send a generic EVM-to-EVM message. We made a compliance
acknowledgement the trigger, which we think is closer to what 2.0 is actually
for.

We do not use ACE.
