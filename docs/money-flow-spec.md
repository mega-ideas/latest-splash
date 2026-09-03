# Money-flow section — spec (landing v2 §3.3)

Reference for `components/landing-v2/MoneyFlow.tsx`. This section replaces the old `#how-it-works` and is the one signature moment on the landing: five node groups, one atomic transaction in the middle, and money visibly moving.

## Layout

- **Toggle pill** "Send | Batch payout" (white group; active = white on ink-900). Crossfade 250 ms; swaps the step-card copy. Sticky at the top of the section below `md`.
- **Five node groups**, left → right on desktop, stacked vertically below `md`:
  1. **Your business** — chips `USD wire · ACH · FPX`; sub "Fund in fiat. No wallets, no gas."
  2. **Splash orchestration** — caption `KYB · screening · FX`; mono chip "Live FX via Pyth".
  3. **HERO NODE** (the only dark card in the section: ink-900, teal ring 20 %, slightly larger) — "One atomic transaction" · mono lines in green-100: `pay · allocate · prove` · small caps "SETTLED ON-CHAIN · ~400MS FINALITY".
  4. **Licensed payout partners** — two stacked white cards: "Philippines — licensed payout partner · PHP", "Indonesia — licensed payout partner · IDR"; ghost third "More corridors" at 40 %.
  5. **Supplier's bank account** — currency chips `₱ PHP` `Rp IDR`, ghosted `$ SGD` `₫ VND` `฿ THB`; sub "Local bank transfer. They never touch crypto."
- **Connectors**: dotted, `rgba(22,63,74,.35)` (implemented as `color-mix(in srgb, var(--ink-700) 35%, transparent)`), three traveling dots per segment, 2.5 s loop, staggered; static at thirds under `prefers-reduced-motion`. Vertical below `md`.
- **Contrast badges** under the connector line: amber "Legacy rails: 2–3 days" spanning node 1 → 2; green "Splash: minutes, end to end*" spanning node 3 → 5. Below `md` the badges sit inline-right of the gap they describe.
- **Footnote** (11 px, muted): "*On-chain settlement ~400ms; total delivery time depends on local payout rails. Illustrative — see pricing."

## Step cards 01–05

Five columns on desktop; horizontal snap-scroll at 85 % width below `md`. Number in mono teal-600, title 17/600, body 14 text-2.

| # | Send | Batch payout |
|---|------|--------------|
| 01 | You fund in fiat | Upload the payout file — fifty suppliers, two countries, one CSV |
| 02 | We verify and price — KYB'd counterparties, sanctions screening, live FX from Pyth; the rate you see is the rate on-chain | (same) |
| 03 | Sui settles atomically — intent confirmed, treasury allocated, audit record anchored; all or nothing | One atomic batch — settles in chunks as single transactions; everyone in a chunk gets paid, or nobody does |
| 04 | Partners pay out locally — PHP and IDR to your supplier's bank | Partners fan out locally — one batch, multiple corridors |
| 05 | You get proof — an on-chain settlement digest your auditor can verify | (same) |

## Never

- Other dark cards in the section.
- Partner names (generic "licensed payout partner · PHP / IDR" only).
- Fixed end-to-end time claims; "minutes" always carries the footnote.
- New hex values; Palette v2 tokens only.

## Implementation notes

| Spec item | Where |
|-----------|-------|
| Toggle | `PillToggle` from `components/system`, `mode` state in `MoneyFlow.tsx` |
| Node cards | `Node` (white) and the inline hero node (`bg-[var(--ink-900)]`, `ring-[var(--teal-600)]/20`) |
| Connectors + dots | `.lv2-connector`, `.lv2-track`, `.lv2-dot` in `app/globals.css` (`lv2-dot-x` / `lv2-dot-y` keyframes) |
| Badges | `AmberBadge` / `GreenBadge`; desktop row is a 9-column grid mirroring the node row; mobile renders them inside `Connector` |
| Step cards | `STEPS[mode]`, `AnimatePresence mode="wait"` crossfade, `useReducedMotion` collapses duration to 0 |
| Corridors | `getNetworkProfile().corridors` (env-driven, generic partner labels) |
