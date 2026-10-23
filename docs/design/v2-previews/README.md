# Splash v2 — approved preview boards (24 Oct 2026)

Design reference only. Rebuild with the repo's own components, tokens and Tailwind classes; do not paste this markup.

| File | Board | Approved |
|---|---|---|
| boards/Main.dc.html | Landing · product section (desktop) — dashboard behind, floating calculator | Yes |
| boards/HeroPhone.dc.html | Landing · product section (phone) — its own layout | Yes |
| boards/ZekePage.dc.html | Zeke page · start | Yes |
| boards/ZekeThread.dc.html | Zeke page · asking to pay (limitation first, then draft card) | Yes |
| boards/ZekeFloat.dc.html | Floating Zeke · opened (chips inside first message), then asked to pay | Yes |
| boards/TransferStep1.dc.html | Transfer · step 1, who you're paying (3 cards) | Yes |
| boards/TransferStep3.dc.html | Transfer · step 3, pay from + inline top-up | Yes |
| boards/HowItWorks.dc.html | Transfer · How it works pop-up | Yes |

Changes after approval (apply when building):
- Calculator routes that are not live: group "Pilot access" + "Request access" action. Never "Coming soon".
- Phone designs are separate compositions, not stacked desktop.

Image references inside the boards (`/_blob/...`):
- `/_blob/6193a3f6…` → `public/splash-main-icon.png` (assets/splash-mark.png)
- `/_blob/4a88e0ea…` → `public/cinematic/agent-bot-cut.png` (assets/zeke.png)
- `/_blob/bde45aec…` → `public/isometric/sui-logo-clean.svg`
- `/_blob/c70d5a65…` → `public/cinematic/hero-district-v5.png` (placeholder until hero-district-v6)

Example numbers in the boards are illustrative (5,000 USDC base, 0.70% fee = 35.00, 1 USDC = 57.40 PHP → ₱287,000.00; IDR example 1 USDC ≈ 16,290 IDR).
