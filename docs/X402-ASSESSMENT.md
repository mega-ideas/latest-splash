# x402 on Splash — can it be integrated now?

*Assessed 2026-09-23 against the Arbitrum workshop facilitator
(github.com/hummusonrails/x402-facilitator) and the x402 spec it implements.*

## The verdict, in one paragraph

**Not into the money path today — and the blockers are Splash's own
invariants, not missing plumbing.** What ships now instead: Zeke can parse an
x402 challenge, price it exactly, and explain it to an operator
(`lib/agent/x402.ts`, `tests/x402.test.mjs`), and settlement is a refusal
that names its reasons. Real spending arrives with the session-payment
mandate — the capped, revocable, human-signed budget from Build Prompt v3.1
§3.2 — which is Move work awaiting Sebastian.

## What x402 is

HTTP 402 as a payment handshake: a server answers `402 Payment Required`
with `accepts[]` — scheme `exact`, a network, an ERC-20 asset (USDC), a
`maxAmountRequired` in base units, a `payTo` address. The client signs an
EIP-3009 `transferWithAuthorization` and retries with an `X-PAYMENT` header;
a **facilitator** verifies the signature and settles it on-chain. The
workshop repo is that facilitator for Arbitrum One / Arbitrum Sepolia. The
design goal is agent-to-service micro-payments with no accounts and no
human in the loop per request.

## Why it does not plug into Splash's money path yet

1. **Wrong rail.** Splash settles on Sui; x402 `exact` settles USDC on EVM
   chains via EIP-3009 — a signature format Sui does not speak. Integration
   on the spend side means Splash operating an EVM wallet with a hot key:
   a brand-new custody surface that none of the Move invariants, CI guards
   or the security review ever looked at. That is not a config change; it
   is WS-scale work with Sebastian's name on it.

2. **Wrong trust model — and that one is load-bearing.** The product's first
   law, enforced at three independent points, is that the agent prepares and
   a **named human approves every release of value**. Autonomous
   per-request payment is not a missing feature of Zeke; it is the failure
   mode the control plane exists to prevent. Wiring x402 spend directly into
   the agent would be the first crack in the invariant the whole trust page
   stands on.

3. **The honest bridge already has a name.** The session-payment mandate
   (v3.1 §3.2): a human signs a capped, expiring, revocable budget on-chain
   — one counterparty, per-payment cap, total cap — and deterministic code
   enforces it. An x402 spend wallet funded and bounded by a mandate is
   agentic payment that *keeps* the principal model. Until that primitive
   exists (Move, `splash_core` packaging decision, Sebastian's sign-off),
   x402 spend has no home that respects the invariants.

The **receiving** side (Splash pricing its own APIs in x402) has no product
need today and the same wrong-rail issue in reverse.

## What ships now (done, in this commit)

- `lib/agent/x402.ts` — a strict parser for 402 challenges (refuses unknown
  schemes and non-integer amounts rather than rounding; money is bigint
  minor units per house rule), an exact base-units formatter, an
  operator-facing description that flags networks no known facilitator
  serves, and `x402SettlementAvailability()` — a refusal that carries its
  reasons.
- `tests/x402.test.mjs` — five tests, including the workshop-shaped
  Arbitrum Sepolia challenge.
- Deliberately **not** registered as a live agent tool yet: the tool
  registry is pinned by the capability tests as the agent's exact surface,
  and a tool that can only quote invites "just finish it" pressure. It
  registers in phase 2, below.

## The path, when it opens

| Phase | What | Blocked on |
|---|---|---|
| 1 (now) | Parse, price, explain; refusal on settle | nothing — shipped |
| 2 | `quoteX402Payment` as a read tool + a proposal lane: the challenge becomes an unsigned proposal in the queue, a human approves each one | product call: is one-click-per-request approval useful, or noise? |
| 3 | Session mandate on-chain; an EVM spend wallet funded within a mandate's caps; x402 payments auto-release **inside** the budget a human signed | `mandate.move` (Sebastian), KMS-held EVM key, facilitator selection |

Phase 3 is the one that makes the workshop demo real without breaking the
product's word. Everything before it is honest preparation.
