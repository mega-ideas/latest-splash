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

## 7. Public site (`components/landing-v2`, `components/site`, `components/auth`)

- **Landing v2** (`components/landing-v2/LandingV2.tsx`): nav → hero → proof strip → bento → money-flow → five steps → treasury vision → rates teaser → onboard → trust → corridors → roadmap teaser → footer. One responsive tree; sections use `Section` (96/64 rhythm), `TwoTone` (two-tone headline utility), `Lede`, `Mono` (module chips) from `ui.tsx`. `Reveal` is the only scroll motion (400ms, 12px, once; opacity-only under reduced motion).
- **Money-flow** is specified in `docs/money-flow-spec.md`. Exactly one dark card in the section (the settlement node). Connector dots are CSS (`.lv2-connector` in `globals.css`), static at thirds under reduced motion.
- **Hero visuals** are live renders (`HeroDeskPreview`, `HeroPhonePreview`) of real system components with sandbox sample data, fixed boxes (zero CLS), `aria-hidden`.
- **Public pages** (`/pricing /rates /trust /roadmap /docs /sandbox /metrics`) use `SiteShell` + `PageHeader` + `PageBody` from `components/site/SiteShell.tsx` and `DataTable` (server-renderable; row cards below `md`, or sticky first column + horizontal scroll with `scroll`). Milestone strings live once in `lib/site/roadmap.ts`.
- **Auth** (`/login`) uses `AuthShell` (form left, iso scene + posture right, hidden below `lg`) and `LoginForm` on system inputs (16px text, 44px targets, visible labels, inline error with `role="alert"`).
- **Eyebrow budget:** at most one mono kicker per three sections on the landing; today two ("How it settles", trust caption).

### Contrast amendment (axe, WCAG AA at rendered sizes)
- `--text-muted` is `#59686F` (the brief's `#6B7A83` measured 4.43:1 on white at 11-13px).
- 700 text shades exist for status text on the 100 tints and on white: `--teal-700 #16606E`, `--green-700 #157056`, `--amber-700 #8A5809`, exposed as `--info-text / --ok-text / --warn-text` (`--error-text` = red-600, which already passes). The 600 shades remain for fills, borders, large figures and links on paper.
- Ghost placeholders use a dashed border and muted text, never 40% opacity on text.

### Stylesheet architecture (performance)
- `app/globals.css` (≈520 lines): Tailwind v4, `@theme`, `styles/tokens.css`, base + body, the public `/trust` rules, `.money`, brand chrome, landing-v2 motion (`.lv2-*`). This is everything a public page needs.
- `styles/legacy.css` (≈8,700 lines): dashboard, admin, queue, pay, the old auth shell, working-capital and the retired isometric/cinematic landings. Imported only by the route layouts that still use those classes (`app/dashboard`, `app/admin`, `app/queue`, `app/pay`, `app/settings`, `app/signup`, `app/forgot-password`, `app/working-capital`, `app/receipt`, `app/help`, `app/design`). A public page never downloads it.
- `styles/loading.css`: the seven rules the root loading screen uses (extracted from the retired cinematic stylesheet).
- Providers (react-query + sonner) mount in those same app layouts, not in the root layout; the landing and public pages ship no toast or query runtime. Landing motion is CSS (`Reveal` toggles a class on intersection; the money-flow toggle crossfades on remount); framer-motion is not in the landing bundle.
- Brand icon assets are 256px (`public/brand/splash-icon.png`, `public/splash-main-icon.png`; the 841px original is `splash-icon@full.png`); `app/icon.png` is 256px.

## 8. Clearance Signal layer (v4, `feat/v4-clearance-signal`)

Adopted from the "Global Payment Clearance" handoff (`docs/clearance-signal-plan.md`) with our own branding: Palette v2 stays (ink-900 foundation, paper canvas, teal-600 as the single signal/action colour, green/amber/red for verified/attention/exception; no orange, no iris), Geist + Geist Mono stay, copy stays truthful.

**Semantic tokens** (`styles/tokens.css`, after the primitives): `--surface-canvas/raised/subtle/navigation/navigation-active/selected/verified/attention/exception`, `--signal`, `--signal-hover`, `--state-data/verified/attention/exception`, `--text-on-dark`, `--border-default/strong`, `--focus-ring`, `--r-control` (8px), `--sidebar-width` 11.5rem, `--sidebar-collapsed-width` 4rem, `--topbar-height` 3rem, `--inspector-width` 25rem, `--row-height` 2.75rem, `--dur-fast` 120ms, `--dur-ui` 160ms, `--tracking-label` 0.055em.

**Shell primitives** (`components/shell`): `StatusLabel` (exact status vocabulary → tone; never colour alone), `ClearanceProgress` (six checkpoints B · FX · POL · APP · EXE · PRO; complete/active/attention/exception/pending), `EvidenceList`, `DataTable` (semantic table, 44px rows, 1px dividers, selected row = teal-100 + 2px signal edge, list blocks below md), `Inspector` (right rail at lg; full-screen sheet below lg only when it can be closed, otherwise it stacks under the list; Escape closes, focus moves to the title and back to the opener), `PageHeader`, `Workspace`, `SummaryStrip`, `GroupHeading`.

**View model** (`lib/payments/clearance.ts`): `fromTransfer`, `fromProposal`, `groupRecords` (needs clearance / in flight / attention / cleared), `routeAlternatives` (partner rail vs reviewed Bank SWIFT and Digital MTO baselines, always labelled illustrative), `destinationFor`, `shortTime`. Money formatting is code-first with tabular numerals (`lib/money.ts`).

**Information order everywhere**: decision → money → route → checkpoints → evidence → identifiers → action. One primary action per view. Approval is separate from execution; creation never moves funds.

**Landing** (`components/landing-v3`): dark nav (Platform / Network / Security / Developers / Company), hero with a real HTML clearance strip (KUL → MNL, six checkpoints, effective FX, all-in cost, delivery, quote freshness, live state), proof band, operating model, route comparison, corridor atlas, governance, three-way reconciliation, developers, final CTA, footer. Regions alternate ink and paper; the signal colour traces one route through the page. Motion: checkpoints and route path arrive in sequence, still under `prefers-reduced-motion`. No gradients, no floating mockups.

**Contrast**: text on the ink foundation uses `--text-on-dark` at ≥ 72% opacity for 10–11px labels (axe WCAG AA at rendered size).

## 9. Palette v3 "Clear Air" (branch `feat/v5-clear-air`)

A new breath over the v2 teal: luminous cool neutrals, a deep night foundation, one cobalt signal, and a single warm ember reserved for brand chrome. Type stays Geist + Geist Mono. The method follows a compact brand system (neutrals with defined roles, a small accent set with one job each); the hexes are Splash's own.

| Token | Hex | Role |
| --- | --- | --- |
| `--night-900` | `#0E1526` | Foundation: navigation, hero, dark landing regions, primary text |
| `--night-700` | `#1A2440` | Navigation active |
| `--beacon-600` | `#2D5BFF` | The signal: primary action, links, focus, selection edge (5.2:1 with white text) |
| `--beacon-500` | `#4A72FF` | Hover / active |
| `--beacon-700` | `#1E42D8` | Signal as text on light surfaces (7.4:1 on white) |
| `--beacon-300` | `#8FA8FF` | Data lines, illustration tint, labels on night (8:1) |
| `--beacon-100` | `#E4EAFF` | Selected row, info tint |
| `--ember-500` | `#FF6A3D` | Brand only: the wordmark's full stop and marketing eyebrow rules. Never a state, never a control |
| `--air-50` / `--air-100` / `--white` | `#F5F7FA` / `#EAEEF4` / `#FFFFFF` | Canvas / subtle / raised |
| `--text` / `--text-2` / `--text-muted` | `#0E1526` / `#4B5568` / `#5D6779` | Body, secondary, captions (AA at 11–13px on white and air-100) |
| `--border` / `--divider` / `--border-strong` | `#DCE1EA` / `#E7EBF1` / `#C6CDD9` | 1px dividers, strong edges |
| green / amber / red | unchanged from v2 | Verified / attention / exception |

Dark mode: canvas `#0B1020`, raised `#121A2E`, subtle `#1A2340`, selected `#1E2A52`, text `#E9EDF5`, beacon lifts to `#8FA8FF` (hover `#A9BCFF`).

The v2 names (`--ink-900`, `--teal-600`, `--paper`, …) remain as aliases to the v3 values so every surface re-skins at once; the clearance semantic layer (`--signal`, `--surface-navigation`, …) is the API for new code. Brand icons were recoloured toward beacon (hue +38°, saturation ×1.35) from the teal originals.

Why this and not the obvious defaults: cream-plus-terracotta and near-black-plus-acid-green are the two most common generated looks right now, and every payments incumbent is teal or navy. Cobalt on luminous air reads as sky and clearance; the ember is the one warm point, spent in exactly two places.

## 10. Web3 landing (branch `feat/v7-web3-light`, `components/landing-w3`)

A light, motion-led public landing in the language of the current web3 fintech leaders (nullmask.io, spade.com were the named references): warm bone canvas, near-black ink, ONE acid signal, mono labels, oversized tight display type, dark bands for rhythm. Scoped to `.w3` in `styles/landing-w3.css`, so the product keeps its own palette.

| Token | Hex | Role |
| --- | --- | --- |
| `--bone` / `--paper` / `--shell` | `#EFEEE7` / `#FFFFFF` / `#E5E3DA` | Canvas / raised / band |
| `--pool` / `--pool-2` | `#0B1310` / `#14201C` | Dark bands, footer |
| `--ink` / `--ink-2` / `--ink-3` | `#0B1310` / `#414D48` / `#515E59` | Body, secondary, labels (AA on bone and shell) |
| `--aqua` | `#00E5C0` | The signal, used as a **fill** with ink text on it |
| `--aqua-600` / `--aqua-700` | `#00B396` / `#00705E` | Strokes and focus / the only aqua allowed as small text |
| `--aqua-pool` | `#45F2D2` | Signal on the dark bands |
| `--line` / `--line-strong` | `#D8D6CC` / `#BFBCAF` | Hairlines |

Type: **Archivo** 700 for display (clamp 2.75–5.75rem, tracking −0.042em, leading 0.94), **Inter** for UI, **JetBrains Mono** for labels and evidence. Radius 4–8px.

**Motion tokens**: `--d1` 130ms feedback, `--d2` 240ms state, `--d3` 460ms entrance, `--d4` 820ms choreography, ease `cubic-bezier(.2,.7,.2,1)`, 90ms stagger. Choreography: hero lines rise from a clipped mask, the signal swipe draws under the last line, the route path draws and its checkpoints pop in sequence, the corridor marquee loops and pauses on hover, sections rise 18px on entry, the flow spine fills and its stage dots flip to signal, proof figures count up once.

**Motion safety rules, enforced in the stylesheet**
- Content is authored in its final state. The offset for a revealed element applies only while `.w3[data-motion="ready"]` is set by a client effect, so with no JavaScript nothing is hidden. Verified: 71,353 characters render with JS disabled.
- `prefers-reduced-motion: reduce` never sets that flag, collapses all durations to 1ms, stops the marquee, and lands every drawn path, swipe and counter at its end state.
- Nothing is gated behind an animation; every observer unobserves after one fire.

Verified at 1440 and 375: axe (WCAG 2.1 AA) clean, no page errors, focus rings on every control, no unclipped horizontal overflow, touch targets ≥44px on coarse pointers (footer word-links are 48px tall and as wide as their word).
