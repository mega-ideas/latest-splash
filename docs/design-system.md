# Splash design system (v2)

Tokens live in `styles/tokens.css`; Tailwind utilities for them are mapped in `app/globals.css` (`@theme inline`); components live in `components/system/`; the isometric illustration library lives in `components/illustrations/iso/`. The gallery at `/design` renders every component in both themes (served outside production, or with `NEXT_PUBLIC_DESIGN_GALLERY=true`; never indexed).

CI: `scripts/check-copy.mjs` fails on any raw hex literal in `app/` or `components/` that is not in Palette v2 (retired v1 hexes are allowed only under `components/illustrations/`; legacy surfaces are grandfathered per file until they migrate).

## 1. Palette v2

| Token | Light | Use |
|---|---|---|
| `--ink-900` | `#0B2A33` | Headline ink, the one dark card |
| `--ink-700` | `#163F4A` | Secondary ink, dotted connectors at 35% |
| `--teal-600` | `#1F7A8C` | Primary interactive: buttons, links, focus |
| `--teal-500` | `#2E96A8` | Hover / active |
| `--teal-300` | `#5C9EAD` | Brand tint: illustrations, chart lines, tints only, never text on light |
| `--teal-100` | `#DCEEF1` | Tints, top faces in illustrations |
| `--paper` | `#F7F8F7` | Page background |
| `--surface` | `#FFFFFF` | Cards, inputs |
| `--surface-2` | `#EEF3F4` | Tinted cards, table headers, skeletons |
| `--text` / `--text-2` / `--text-muted` | `#0B2A33` / `#4A5C64` / `#6B7A83` | Body, secondary, captions (AA at 13px) |
| `--border` / `--divider` | `#DCE3E6` / `#E8EDEF` | Field borders, row dividers |
| `--green-600` / `--green-100` | `#1E8F6E` / `#DDF3EA` | Settled, positive; the single highlight material in illustrations |
| `--amber-600` / `--amber-100` | `#B9770E` / `#FBEFD9` | Pending; legacy-rail contrast badges |
| `--red-600` / `--red-100` | `#B93A32` / `#FAE3E1` | Returned, rejected |
| `--gradient-hero` | ink-900 → teal-600 at 135° | Behind product screenshots only |
| `--focus-ring` | `2px solid --teal-500`, offset 2px | Every interactive element |

Semantic aliases: `--accent` (teal-600), `--ok`, `--warn`, `--error`, `--info` with their `-bg` pairs. Components use the aliases so dark mode is a token swap.

**Dark mode** follows `prefers-color-scheme` unless the viewer chose a theme (`data-theme` on `<html>`, set by `ThemeToggle`, applied before first paint by an inline script in `app/layout.tsx`): bg `#071C22`, surface `#0F2C35`, surface-2 `#153845`, text `#E6EEF0`, muted `#9BB0B7`, accent `#7FCBD9`, green `#5FD3A8`, amber `#E8B04B`, red `#F08A82`.

**Retired from UI** (illustration only): `#E39774` coral, `#1F4452`, `#F6F0ED`, `#6FB4A0`, and the landing's local gold/teal family.

## 2. Typography

Geist for UI and headlines; Geist Mono for digests, module chips, IDs, and (optionally) money in tables.

| Role | Size | Weight / tracking |
|---|---|---|
| Display | `clamp(2.25rem, 6vw, 3.5rem)` | 600, −0.02em |
| H1 | `clamp(1.875rem, 5vw, 2.5rem)` | 600 |
| H2 | `clamp(1.5rem, 4vw, 1.75rem)` | 600 |
| H3 | 20px | 600 |
| Body | 16 / 15 px, line-height 1.55 | 400 |
| Caption | 13px | 500, +0.01em |

Two-tone headline: line one `--text`, line two `--text-2` (see the gallery). Tabular numerals on every money figure; order is always **amount > currency > label**. Truthful asset labels everywhere: "USD claim", "USDC", "USDY" — never "USD" for a token balance.

## 3. Surfaces, spacing, motion

- Radii: 12 (fields) / 16 (cards) / 20 (panels) / 999 (pills). Shadows: rest `0 1px 2px rgba(11,42,51,.05)`, elevated `0 8px 24px rgba(11,42,51,.10)`.
- 4-pt spacing (`--s1`…`--s9`); section rhythm 96 desktop / 64 mobile.
- Motion: Framer Motion; 220ms UI, 320ms flows, 400ms reveals; easing `cubic-bezier(.22,1,.36,1)`; reduced motion collapses to opacity-only or static. Never animate width/height; never scroll-jack.
- Breakpoints only `sm 640 · md 768 · lg 1024 · xl 1280`. Touch targets 44px with 8px gaps; sticky CTAs pad `env(safe-area-inset-bottom)`.

## 4. Component inventory (`components/system`)

| Component | Purpose · key props |
|---|---|
| `Button` | `variant: primary \| ghost \| destructive-text`, `size: sm \| md \| lg`, `href`, `fullWidth`. One primary per screen. |
| `PillToggle` | Segmented control (`options`, `value`, `onChange`, `label`); arrow keys move, `aria-pressed` announces. |
| `Card` | `tone: default \| tint \| dark`, `padding`, `elevated`. Exactly one dark card per composition. |
| `Stat` | `label`, `value`, `currency` (truthful label), `tone`, `loading` (money skeleton), `sub`, `action`. |
| `Badge` | `tone: amber \| green \| slate \| red \| teal`, `outline` for contrast badges. Words carry meaning, never colour alone. |
| `Chip` | Mono chip for infrastructure and module names; `tone`, `ghost` (40%). |
| `Table` | `columns` (align/mono/render/value/secondary), `rows`, `caption`, `exportName` (CSV on every table), `rowAction`, `emptyState`. Rows become cards below `md`. |
| `AmountInput` | Label above, helper/error below, decimal keyboard, 16px+, tabular numerals. |
| `StepStrip` | Real sequences only; `steps`, `current`, `footnote`. Vertical below `md`. |
| `BentoGrid` / `BentoCell` | Six-column bento; `span 2 \| 3 \| 4 \| 6`, `rowSpan`. As many cells as there is content. |
| `ProofDrawer` / `ProofRow` | Collapsed proof layer; the only place raw chain vocabulary appears on a business surface. |
| `SettlementTimeline` | D7 states (`lib/settlement/delivery-states.ts`): `rail: sui-native \| cctp \| wire`, `entries` with evidence; RETURNED / HOP_STUCK branches. |
| `PolicyCard` | Rule in plain words, scope, enforcement badge, module chips. |
| `ChatComposer` | Auto-growing composer, Enter sends, attach slot, docked safe-area, "Prepare" verb. |
| `EmptyState` | Focal iso art + title + one action. |
| `Skeleton` | `block \| text \| money \| circle`; reserve final shape for every async money value. |
| `ThemeToggle` | Manual light/dark, persisted per browser. |
| `components/brand/*` | `Wordmark`, `NetworkBadge`, `SandboxRibbon`, `PostureFooter` (env-driven via `lib/network.ts`, names via `lib/brand.ts`). |

`ActionCard` (0xWal) is restyled in the 0xWal PR; `SettlementProofDrawer` migrates onto `ProofDrawer` in the receipts PR.

## 5. Isometric v2 — systems illustration (`components/illustrations/iso`)

- True isometric 30°/30°, fixed camera, 8px iso grid, elevation 0/1/2, lighting top-left.
- 1.5px stroke in `--ink-900` (2px on the focal object); top faces `--teal-100`; side faces `--surface`; ONE highlight material `--green-100` reserved for settled money; ambient shadow 8% ink; no gold, no hard drop shadows, no extruded type.
- Labels are flat planes above objects; Geist Mono for IDs; labels never collide with routes.
- Module vocabulary: `BusinessBlock`, `SplashNode` (hex), `SuiSettlementStack` (pay / allocate / prove slabs), `PartnerTower`, `BankBlock`, `RouteConnector` (dot-flow), `ReceiptToken`, `ApprovalGate`.
- Compositions: `MoneyFlowDiagram`, `CorridorMap`, `EmptyState`, `NotFoundScene`, `LoadingScene`, `ReceiptArt`. Motion: dots along routes, slabs assemble on settlement, gate opens on approval; static under reduced motion. Responsive crops: `focal` (mobile) / `full`; export 320/640/1280.
- Illustration language only: never headline type, never interactive chrome.

## 6. Do / don't

- **Do** put the one dark card where the money settles; **don't** add a second dark card to the same composition.
- **Do** label balances by asset; **don't** call a token balance "USD".
- **Do** footnote every corridor fee or speed figure as illustrative; **don't** state end-to-end times as guarantees.
- **Do** use `Badge` words for state; **don't** rely on colour alone.
- **Do** use the extruded look in illustrations; **don't** extrude type or chrome.
- **Do** import names from `lib/brand.ts`; **don't** hardcode "Splash" in new code.
