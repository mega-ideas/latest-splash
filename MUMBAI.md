# Splash × ETHGlobal Mumbai

Splash × ETHGlobal Mumbai. Every Splash payment carries a proof of who sent it,
who receives it and under which rule — and Splash charges a fee only when that
proof is recorded.

**Before this event.** Splash was a Sui-only testnet build. It assembled three
travel-rule records offchain (`travelRuleSnapshot()`, `pacs008ForInstruction()`,
`sumsubTravelRuleBody()`) and committed none of them to any chain, and
"charge only on proof" existed only in the fee policy.

The baseline is this repository's **`main`** branch at `348a9a90` (2 Nov 2026),
untouched by the event.

**Everything built during the event is on the `mumbai` branch**, and the whole
of it lives in two directories: `arc/` (the escrow, authored in Arc Studio) and
`mumbai/` (everything else). Nothing outside those two was changed, so
`main...mumbai` is exactly the submission and nothing else.

**During this event.** The travel-rule commitment, an escrow on Arc released by
a beneficiary's acknowledgement, that acknowledgement carried from Ethereum
Sepolia over Chainlink CCIP, a USDT invoice checkout on Whitechain, and the Sui
audit anchor that ties them together.

## The proof rule

    commitment = blake2b256( utf8("splash:travel-rule:v1") || bcs(record) || salt32 )

Only the 32-byte commitment goes onchain. The beneficiary recomputes it from the
record and salt it received offchain; that recomputation is what its
acknowledgement proves. One scheme on every chain, one value per payment.

## Layout

| Path | What |
| --- | --- |
| `mumbai/lib/travel-rule-commitment.ts` | The commitment, reproducing `latest-splash`'s scheme |
| `mumbai/evm/sepolia/` | `SplashTravelRuleAck.sol` — the beneficiary's acknowledgement, sent over CCIP |
| `arc/` | `SplashProofEscrow` — authored in Arc Studio |
| `mumbai/evm/whitechain/` | `SplashInvoice.sol` — USDT checkout, fee held until proof |
| `mumbai/scripts/` | Beneficiary service, Sui anchor, CSV export |

## Status

Preflight, verified onchain rather than from docs:

| Check | Result |
| --- | --- |
| Arc testnet chain id | `5042002` |
| Arc CCIP router deployed | yes, 10.7 KB bytecode, `Router 1.2.0` |
| Sepolia router `isChainSupported(3034092155422581607)` | `true` |

## Trust model

On Arc the acknowledgement comes from the beneficiary's own key and is verified
by Chainlink's committee. An admin sets which sender is allowed and can at worst
release early, to the correct recipient; no admin path moves principal. On
Whitechain a Splash attestor records the proof.

Simulated in this demo: the MYR and PHP legs, the travel-rule record itself, and
the Splash attestor on Whitechain.

## Licence

Apache-2.0.
