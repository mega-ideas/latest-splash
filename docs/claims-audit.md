# Claims & copy audit — v3 mainnet redesign (Phase A)

**Date:** 2026-09-02 · **Branch:** `feat/v3-mainnet-redesign` · **Scope:** `app/`, `components/`, `lib/`, `content/` (rendered copy, agent replies, structured data, aria/alt text), plus a read-only scan of `move/`.

## The canon this audit enforces

- No **yield / yielding**, **escrow / escrowing**, **discounting**, **netting** presented as *live* capabilities. Roadmap framing (RoadmapChip, "subject to licensing", "when the e-money licence is granted", Phase 1/2) is allowed.
- No fixed APY; no numeric rate presented as an offer.
- Splash is never "licensed". "Licensed payout partner" (generic, unnamed) is the only permitted licence attribution. The MFCA is never a licence.
- No "guaranteed"; no "instant" without an illustrative footnote (prefer "in minutes", "no notice period", "on settlement").
- Corridor fee and speed figures are illustrative and say so.
- Operative posture everywhere: **no customer funds until MFCA activation**.
- Disclosure policy D5: partners are described by role, never named, on public and in-product surfaces; legal names only on receipts to the transaction parties.

## Method

1. `rg -in` over the four roots for `yield`, `escrow`, `discount`, `netting`, `licen[cs]e`, `guarantee`, `APY`, `\binstant`, `\bnets?\b` → **~460 raw hits**.
2. Every hit classified by surface (user-facing copy · identifier · comment · test · data-config · server-only) and verdict (**violation** · **allowed** · **flag-for-human**), with the file opened for context. The discount, licence, APY and instant families were additionally re-checked by an adversarial second pass.
3. Violations replaced in this PR; flags recorded below for human + Sebastian; `scripts/check-copy.mjs` extended so CI fails on regression.

Line numbers below are **pre-change** lines on `main` (`1d4589b`).

## Summary

| Family | Raw hits | Violations (fixed) | Flag for human | Allowed |
|---|---|---|---|---|
| yield / APY | 224 | 33 | 6 | 185 |
| escrow · netting · guarantee | 85 | 15 | 6 | 64 |
| discount | 66 | 5 | 1 | 60 |
| instant | 25 | 13 | 2 | 10 |
| licence / licensed | 47 | 1 | 1 | 45 |
| `move/` (on-chain visible) | 24 | 0 (policy: never edit) | 4 | 20 |

Every violation below has a replacement applied in this PR. Identifiers, enums, comments, tests and server-only strings were left alone unless a rendered label depended on them.

## Violations and replacements applied

### Landing (highest exposure)

| Location | Was | Now |
|---|---|---|
| `components/landing/SettlementCinematic.tsx:210` | H1 "Send USD across Southeast Asia in minutes — starting with the Philippines" | Locked copy: "Send USD across Southeast Asia in minutes — starting with the Philippines and Indonesia." (corridor clause rendered as line two) |
| `SettlementCinematic.tsx:213-214` | "…Between the invoice and the settlement, Splash **nets, yields, discounts, and escrows** — with human approval on every action." | "Cross-border USD, settled atomically on Sui, batched, proven on-chain and guarded by spend limits. A human approves every action." |
| `SettlementCinematic.tsx:256-259` | Vision lede: "Stripe and Airwallex move money. Splash runs everything between the invoice and the settlement — netting it, yielding it, discounting it, escrowing it." | "Splash runs everything between the invoice and the settlement: settling it atomically, batching it, proving it, guarding it." (competitor sentence removed) |
| `SettlementCinematic.tsx:260-265` | Pillars "Netting · Yield · Discounting · Escrow" (gold chips, aria-hidden) | Pillars "Atomic settlement · Batch payouts · On-chain proof · Spend guardrails" with mono module labels `payment_intent · PTB batch · audit_anchor + receipt_v2 · spend_meter + guardian`; rendered as a real list (no longer aria-hidden) |
| `SettlementCinematic.tsx:251-255` | Gold chip "The product" + extruded, shadowed display headline | Mono kicker + flat Geist two-tone headline (`.cin-vision-title-v2`); extruded type retired from this block (D4) |
| `SettlementCinematic.tsx:56` | Telemetry tag "Treasury · Approval-gated" over `lockedCopy.yield` | "Treasury · Roadmap" |
| `content/claims.ts:15` | `lockedCopy.yield = 'Variable APY - T-bill-backed'` (rendered in hero telemetry) | `'Projected T-bill posture · roadmap'` (evidence line in `claims.treasuryYield` updated to match) |
| `components/IsometricLanding.tsx:203` | Comparison row "Buyer-approved discount offer" | "Buyer-funded early payment (roadmap)" |
| `IsometricLanding.tsx:205-211` | Comparison row "Bilateral netting · Modeled in account loop" | Row removed until Phase 2 |
| `IsometricLanding.tsx:475-479` | "Yield on idle USD" row with Splash cell "`N% projected variable APY`" | "Idle USD posture (roadmap)" with Splash cell "Projected, variable — not a live offer" (third-party benchmark cells unchanged) |
| `IsometricLanding.tsx:751,755` | "Reference yield benchmark" · "Yield is hygiene, not the headline — the working-capital loop is." | "Reference rate benchmark" · "Splash treasury posture is a roadmap projection, not the headline." |
| `IsometricLanding.tsx:628-629` | "Working-capital branch: Accepted invoice to supplier discount offer to buyer approval to settlement proof." | "Working-capital branch · roadmap: Accepted invoice to buyer-funded early payment to approval to settlement proof. Subject to licensing." |
| `IsometricLanding.tsx:387-393` | Loop card "Save" with `roadmap: false`, alt "…growing along a yield curve…" | `roadmap: true` (RoadmapChip renders), meta "Projected · variable · roadmap", alt "…in a projected, approval-gated posture" |
| `IsometricLanding.tsx:272` | Copilot layer "Model payout liquidity and projected yield…" | "…and a projected treasury posture (roadmap)…" |
| `IsometricLanding.tsx:118-120` | Partner rail names Stripe and Airwallex | Removed from the public rail (D5); infrastructure vendors (Pyth, DeepBook, Sumsub, Walrus, Sui) remain |
| `IsometricLanding.tsx:587` | "Licensed-partner rails outside." | "Licensed payout partners at the far end of every corridor." |
| `components/supply/WorkingCapitalFlywheel.tsx:56-63` | Save loop `status: 'live'` | `status: 'roadmap'`, future-tense copy |
| `components/supply/DiscountTermSheet.tsx:19-20,47` | "Buyer earns $1,200 on idle USD held ~90 days — ≈ 4.9% p.a." | "Buyer keeps $1,200 for paying ~90 days early — an illustrative worked example, not an offer." (annualised-return figure removed) |
| `app/page.tsx:34` | FAQ JSON-LD "…starting with the USD to PHP corridor on testnet…" | "…starting with the Philippines and Indonesia… No customer funds are held until MFCA activation." |
| `app/page.tsx:58` | FAQ "Corridor fees start from a 0.80% edge fee." | "Corridor fees are illustrative and start from a 0.80% edge fee; the exact fee varies by corridor and volume." |
| `app/page.tsx:71-75` | FAQ "Is the treasury yield fixed?" (presupposes a live yield) | "Does Splash pay a treasury rate today?" → "No. Smart Treasury is a roadmap capability…" |
| `app/layout.tsx:20,23,28` | Description "…keep cash working in a labeled sandbox environment." / OG "Collect USD. Pay Southeast Asia. Keep cash working." | Description carries the locked H1 and "No customer funds until MFCA activation"; OG/Twitter "Send USD across Southeast Asia in minutes. Settled atomically on Sui, proven on-chain." **Meta title unchanged.** |
| `app/opengraph-image.tsx:193-198` | OG headline "Collect USD. / Pay Southeast Asia. / Keep cash working." | "Send USD across / Southeast Asia / in minutes." |

### Trust and money-path (disclosure policy D5)

| Location | Was | Now |
|---|---|---|
| `components/compliance/TrustCompliance.tsx:9-30` | Partner table naming Coins.ph ("BSP-licensed"), Hata Global, BitGo, CoKeeps/Gambit | Role-only rows: "Licensed payout partner · PHP", "Licensed payout partner · IDR", "Licensed collection partner · USD", "Key-governance provider". The mandatory sentence "Splash is not yet a licensed money-services business." is unchanged and now build-enforced. |
| `content/money-path.ts:42-65` | In-product panel named Airwallex and "PDAX · via GCash" | Generic labels ("Licensed collection partner · USD", "Licensed payout partner · PHP / IDR"); an IDR hop added for the second corridor; `legalName` field reserved for receipt fine print (empty until signed). Locked sentences unchanged; `tests/money-path.test.mjs` passes unchanged. |

### Dashboard

| Location | Was | Now |
|---|---|---|
| `app/dashboard/treasury/page.tsx:302` | "Operating cash stays instant. Idle balance earns a floating T-bill rate through Ondo USDY." | "Operating cash stays ready to spend with no notice period. Idle balance is projected to follow a floating T-bill posture through Ondo USDY once treasury execution is approved." |
| `treasury/page.tsx:340` | "+$X yield accrued" | "+$X accrued (simulated)" |
| `treasury/page.tsx:369` | "Instant · funds every payout · 0%" | "No notice period · funds every payout · 0%" |
| `treasury/page.tsx:508,516,553,610` | "USDY daily yield" · "Accrues daily via…" · aria "Daily USDY yield…" · "Daily yield" | "USDY daily accrual · simulated" · "Modeled from the USDY redemption price…" · aria "Simulated daily USDY accrual…" · "Daily accrual (sim)" |
| `treasury/page.tsx:63-66` | Ledger rows "USDY yield accrual" (confirmed) | "USDY accrual · simulated" |
| `treasury/page.tsx:635,639,658,671` | "internal netting removes repeated payout work" · "Netting ratio" · "stays netted" · "Simulation only. Netting reduces…" | Sweep-vs-hold copy reframed around holding balances in the loop; "Sweep-to-hold ratio"; "Internal offsetting is a planned capability, subject to licensing." |
| `treasury/page.tsx:707,713,714` | "T-bill yield" badge · "real, off-chain yield" · step "Yield accrues" | "T-bill posture · roadmap" · "the instrument behind the projected posture" · step "Accrual (projected)" with licence framing |
| `treasury/page.tsx:823` | "Yield is variable and not guaranteed…" (presupposes a live product) | "Treasury figures are projections, not a live offer and not a promise of return. Rates are variable…; nothing is guaranteed." |
| `lib/server/usdy.ts:67` | Rate chip "≈3.50% APY · variable" (rendered on treasury, 0xWal, `/api/market/yields`) | "≈3.50% projected · variable" — one source, every consumer inherits |
| `components/FintechContextBar.tsx:17` | "Manage liquidity, yield, and settlement availability…" · signal "Treasury active" | "…treasury posture stays projected and approval-gated." · "Projection only" |
| `components/dashboard/SettlementEngineFlow.tsx:59` | Node "USDY yield · variable · T-bill" | "USDY posture · projected · T-bill · roadmap" |
| `app/dashboard/page.tsx:77,84` | Activity chips "Scanning netting opportunities" · "Preparing netting settlement" | "Scanning offset opportunities (modeled)" · "Preparing offset settlement (roadmap simulation)" |
| `lib/agent/action-card.ts:125-126` | Impact rows "Yield delta" · "Netting saved" on **every** payment/FX proposal | "Projected treasury delta" · "Modeled offset saving (roadmap)"; `proposePayment` / `proposeFxConvert` no longer populate `nettingSaved` (`lib/agent/oxwal.ts:835,886`), so the row reads "-" outside offset simulations. `tests/oxwal-frontend.test.mjs` updated. |
| `lib/agent/action-card.ts:106` | Evidence label rendered the raw enum `NETTING:…` | Display-mapped to `OFFSET_MODEL:…` |
| `components/transfer/StepDelivery.tsx:12,22` | "Funds stay as USD. Instant." · ETA "Instant"; no footnote on ETAs | "…available on settlement." · ETA "On settlement"; section footnote "Delivery times are illustrative; local rails vary." |
| `components/funding/FundingSelector.tsx:232` · `lib/funding/registry.ts:231` | "Use N USDC balance instantly" · "Use held native USDC balance instantly." | "…— no deposit step" |

### 0xWal replies and prompts

| Location | Was | Now |
|---|---|---|
| `lib/agent/oxwal.ts:1261` | "Corridor fees start at 0.80% on the live USD to PHP testnet path… typically 15-30 bps tighter" | "Illustrative corridor fees start at 0.80% on USD to PHP and 0.90% on USD to IDR; the exact fee varies… modeled at 15-30 bps tighter" |
| `oxwal.ts:1266` | "Live today: USD to PHP on the Sui testnet corridor." | "First corridors: USD to PHP and USD to IDR, launching in a staggered order on Sui, with no customer funds held until MFCA activation." |
| `oxwal.ts:1283` | "Smart Treasury earns a variable Ondo USDY (T-bill backed) yield; your Available balance stays instant at 0%…" | "Smart Treasury is a roadmap capability: a projected, approval-gated Ondo USDY (T-bill backed) posture… live only when the e-money licence is granted. Your Available balance stays at 0% with no notice period…" |
| `oxwal.ts:1288` | "Your Available (instant) and Smart Treasury balances…" | "Your Available (operating cash, no notice period)…" |
| `oxwal.ts:1299,1365` | "bank payout lands in roughly 3-20 minutes…" | "End-to-end delivery… is illustrative, not guaranteed: a bank payout typically lands in minutes…" |
| `oxwal.ts:1334` | "Netting offsets opposing flows… I can scan for netting opportunities and draft an unsigned netting settlement…" | "Offsetting would net opposing flows… It is a Phase 2 capability planned for when the e-money licence is granted; today I can only show modeled figures…" |
| `oxwal.ts:1370` | "Moving idle cash into Smart Treasury is instant and carries no fee." | "…completes in minutes and carries no fee (a projection until treasury execution is approved)." |
| `oxwal.ts:1390` | "typically 15-30 bps inside single-transfer pricing" | "modeled at 15-30 bps… (illustrative)" |
| `oxwal.ts:1405,1134` | Capability replies listing "netting opportunities" and "netting" proposals as live | "modeled offset opportunities (a roadmap capability, not live)… roadmap simulations such as offsetting" |
| `oxwal.ts:946` | Proposal recommendation "Prepare a netting settlement across N verified counterparties." | "Prepare a modeled offset settlement… Offsetting is a roadmap capability: this proposal is a simulation and cannot settle today." |
| `oxwal.ts:218,317` | Tool descriptions "Read modeled and realized netting opportunities" · "Draft an unsigned netting settlement proposal" | Model-facing descriptions now state the capability is modeled/roadmap and never to be described as live |
| `oxwal.ts:106` | System prompt "…or netting figure." | "…or offset figure." |
| `app/api/copilot/chat/route.ts:51,57,110-113` | "I watch… treasury yield…" · "Smart Treasury earns variable Ondo USDY (T-bill) yield; your Available balance stays instant at 0%. Want to move idle USDC in?" · grounded treasury reply "earns from Ondo USDY… 0% but instant" | "treasury projections" · roadmap-framed projection reply · "models an Ondo USDY posture… a roadmap capability… no notice period" |
| `app/api/copilot/chat/route.ts:140-143` (system prompt) | "Smart Treasury earns yield from Ondo USDY at ${rate}…" · "USDC at 0% but instant" | Instructs the model that Smart Treasury is a roadmap projection, never to say it earns yield today, never to state an APY as an offer, never "instant"/"guaranteed", that fee/speed figures are illustrative, and that Splash holds no customer funds until MFCA activation and is not a licensed money-services business |
| `components/FloatingCopilot.tsx:24,39,119` | "USD to PHP is the current testnet corridor. Starting edge fee is 0.80%" · "Smart Treasury earns a variable… yield… 0% but instant" · chip "Treasury yield / My treasury yield" | "…alongside USD to IDR. The illustrative starting edge fee…" · roadmap projection reply · chip "Treasury posture / My treasury projection" |
| `app/dashboard/copilot/page.tsx:103-104,234-238,867` | "0% but instant" · "earns the floating USDY net rate" · "T-bill backed yield via Ondo USDY" · "ready for instant payments" · link "View treasury yield" | "no notice period" · "models the floating USDY net rate (roadmap, not live)" · "…posture — projected… a roadmap capability, not live today" · "ready to fund upcoming payouts" · "View treasury projection" |

### Server comments touched (canon is absolute for the MFCA rule)

| Location | Was | Now |
|---|---|---|
| `lib/server/sui-settlement.ts:662` | "Under the Labuan MFCA licence Splash cannot hold client funds" | "No customer funds until Labuan MFCA activation: Splash cannot hold client funds today" |
| `lib/server/sui-settlement.ts:706` · `lib/server/treasury.ts:24` · `app/dashboard/treasury/page.tsx:134` | Error/comment text tripping the new word rules ("yields SUI", "0%, instant") | Reworded so the CI rule stays strict without allow-listing |

## Flagged for human + Sebastian (not self-approved)

| # | Location | Why it needs a decision |
|---|---|---|
| F1 | `move/splash_custody/Move.toml:4` | Calls the MFCA a "licence" ("Under the Phase 0 MFCA licence this package is NOT PUBLISHED"). Repo/audit-visible, not on-chain. **No Move edits in this workstream (D4).** |
| F2 | `move/splash_core/sources/business_account.move:131` | Doc-comment "For a licensed e-money issuer that is a compliance defect standing on its own" reads as Splash describing itself; `splash_core` publishes immutable to mainnet in September, so the text becomes permanent. |
| F3 | `move/splash_core/sources/payment_intent.move:432,434` | Doc-comments "That already guaranteed…" / "What it did NOT guarantee was WHO does the anchoring" — describe a type invariant, not a service promise, but quotable out of context from verifiable mainnet source. |
| F4 | `app/api/pay/[slug]/route.ts:13-18` | Public pay page prints the beneficiary bank ("Maybank International Labuan Branch", SWIFT) as transfer instructions. Payers need the bank; it is not a payout partner, but confirm it is acceptable under D5 before mainnet. |
| F5 | `components/compliance/TrustCompliance.tsx` (former rows) | Coins.ph was described as "payout partner of record — BSP-licensed" while `content/money-path.ts` had it inactive and Hata Global was named as a venue after the money-path test excluded it. Names are now removed everywhere public; counsel should confirm which partners are actually signed before any name returns (receipt fine print only). |
| F6 | `app/dashboard/overview/page.tsx:418` · `app/dashboard/settings/page.tsx:44` | "Modeled daily yield" · "Smart Treasury models projected Ondo USDY yield; execution gated; projected, not promised" — projection-framed and left as-is; the Phase 2 Treasury rebuild replaces both screens. |
| F7 | `lib/agent/oxwal.ts:1293` · `app/api/copilot/chat/route.ts:45` · `components/FloatingCopilot.tsx:49` | Canned compliance replies present fixture figures ("Daily limit: 43% used ($12,100 remaining)") as fact. Not a claims-rule breach, but demo data rendered without a DEMO label; the Phase 3 0xWal rework should source these from envelopes. |
| F8 | `app/receipt/[token]` + `lib/evidence/settlement.ts` (B6 privacy tiering) | Public receipt shows counterparty name, approver name + org, raw Walrus blob id; the Seal allowlist writes counterparty names to a cleartext sidecar (`data/seal-policies.json`); share tokens are `Math.random()`-derived with no ownership check on mint. **Blob write paths are not changed in this workstream** — needs Sebastian's sign-off on the tiering design (digest + content hashes + amounts public; counterparty and partner detail Seal-encrypted or ledger-side). |

| F9 | `components/auth/LoginForm.tsx` · `app/api/auth/zklogin/route.ts` | The login page shows Google / Microsoft (zkLogin) providers **disabled with a roadmap chip** unless `FEATURE_ZKLOGIN` is enabled server-side. When enabled, the buttons point at `/api/auth/zklogin/start`, which does not exist yet: the OAuth + ephemeral-key + proof client flow is not built. Keep the flag off until it is; never present the providers as working. |
| F10 | `lib/rates/daily.ts` · `app/rates/page.tsx` | No executed-rate store exists. `/rates` renders deterministic sandbox rows labelled "sandbox rows · illustrative"; on mainnet with `RATES_HAVE_VOLUME=true` it renders "no executed volume yet" until a store is plugged in. Real rows must never be synthesised. |
| F11 | `components/landing-v2/HeroDeskPreview.tsx` · `HeroPhonePreview.tsx` | Brief §3.1 asks for AVIF screenshots of the real Home and 0xWal thread. No authenticated screenshot pipeline exists in the build environment, so the hero renders the real surfaces live from the same system components with static sandbox sample data (labelled "Sandbox · no customer funds"). Replace with captures when a pipeline exists; the figures are sample data, not metrics. |

## CI enforcement added (`scripts/check-copy.mjs`)

- **Forbidden-claims rules** (`live-capability`, `guaranteed`, `instant`, `licensed-splash`, `mfca-licence`) with explicit allow-patterns for negations ("not guaranteed"), identifiers (`instant: true`, `'NETTING'`), regex literals, and roadmap framing. Comment lines are skipped except for the MFCA rule, which is absolute. `app/working-capital/` and `components/supply/` are recognised as roadmap-framed surfaces.
- **Required sentence on /trust**: `components/compliance/TrustCompliance.tsx` must contain "Splash is not yet a licensed money-services business." (the money-path locked sentences remain enforced verbatim).
- **Palette v2 whitelist**: raw hex literals in `app/` and `components/` must come from Palette v2 (`docs/design-system.md` §1.1). Retired v1 hexes (`#E39774`, `#1F4452`, `#F6F0ED`, `#6FB4A0`, and the landing's local teal/gold family) are allowed only under `components/illustrations/`. The 49 files that still carry v1 hexes are listed in `legacyHexAllowances`; the list only shrinks — a new file or a new v1 hex in an old file fails CI. Each migration PR deletes its entries.

## Out of scope for this PR (tracked)

- Hardcoded "testnet" / "MY-PH" / "Sandbox" strings across the landing, dashboard shell and composer become env-driven in **PR D** (`lib/network.ts`), not claims edits.
- The extruded hero display type ("Move money. Settle everything.") and the remaining landing sections are retired in **PR 6** (landing v2); this PR only restyles the vision block it rewrote.
- Corridor cards, partner-label copy in the money-flow section and the receipt statement-descriptor explainer land with their sections (PR 6, PR 7).

## v4 Clearance Signal — handoff claims rejected

The design handoff (`Splash-Clearance-Signal-Design-Handoff`) ships example copy that is not true for Splash. None of it was adopted:

| Handoff copy | Why rejected | What shipped |
| --- | --- | --- |
| "Authorised and regulated in the United Kingdom", FCA reference | Splash is not authorised or regulated in the UK; no FCA relationship | `brand.postureLine` (technology platform, not a bank); "Labuan FSA licensing in process · BNM MSB and BSP planned" (already canon on /trust) |
| "14 corridors", corridor atlas across "major financial centres" | Two corridors exist (USD → PHP sandbox, USD → IDR staged); the rest are modelled | Atlas lists two corridors first and marks the remainder "Modelled · not executable" |
| "99.98%" reliability | No measured figure to cite | No uptime figure anywhere; route confidence is shown as an illustrative comparison metric only |
| LON → KUL, GBP 44,820.00 → MYR 263,482.00 | Not a Splash corridor | KUL → MNL, USD 5,000.00 → PHP, computed from the same `routeAlternatives` the product uses, captioned illustrative and sandbox |
| Partner legal names in marketing | Legal names appear only on receipts to transaction parties | "Regulated partner rail" / "licensed payout partner" |
| "Clear a payment" implying funds move | Creation does not move funds | Send flow states "Creation does not move funds. Checker approval is required." next to the primary action; Approvals states execution cannot be recalled after the partner accepts |
| "Signal Orange", "Iris" accents | Brand palette is ours | Palette v2 unchanged; teal-600 is the only signal colour |

`scripts/check-copy.mjs` passes on the branch (W2 float-math debt unchanged).

## v6 landing — handoff mockup ported verbatim (user direction, 2026-09-03)

The user directed that the landing follow the handoff mockup exactly, including its colour and content. `components/landing-v4` is that port. Its figures (14 regulated corridors, 6 evidence layers, 99.98% auto-reconciled, 24/7, the LON → KUL GBP/MYR example, corridor availability table, clearance record, reconciliation rows, API sample) are the mockup's sample data and are not measurements of Splash. Two items were not carried over because they would be false regulatory statements: "authorised and regulated in the United Kingdom" with an FCA reference and company number. The footer's Regulated jurisdictions block carries the canon posture line and the Labuan status instead, and the copyright uses the real legal entity. Before this page is public, the sample figures need either real data behind them or an "illustrative" marker.
