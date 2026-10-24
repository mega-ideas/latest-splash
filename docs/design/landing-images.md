# Landing images

The hero district and the Platform section's stepped pools ship as WebP, not
as the PNG originals (v2 brief section 6, "Image weight").

## What ships

`scripts/landing-images.mjs` reads the best source on disk for each piece and
writes, to `public/cinematic/landing/`:

| File | What |
| --- | --- |
| `<key>-1600.webp` | 1600 px wide, alpha kept |
| `<key>-2400.webp` | 2400 px wide, alpha kept |
| `<key>-phone.webp` | a crop for a 390 px phone, 900 px wide |

A width the source cannot fill is not made: the current pools art is 1200 px
wide, so it ships `liquidity-pools-1200.webp` and no 2400. The manifest
`lib/landing/images.json` lists what exists. Components ask
`landingImage(key)` (`lib/landing/images.ts`), which gives `next/image` a loader
that picks the file for each width in `sizes`. The optimizer never runs on
these and the PNGs are never requested; `tests/landing-v2.test.mjs` fails if a
component names one.

The hero at 1600 px must be under 400 KB. The script steps the WebP quality
down until it fits, and fails if it cannot. Today: about 124 KB at 1600 px and
205 KB at 2400 px, against 3.9 MB for the v5 PNG.

## Sources, best first

| Key | Preferred | Until then |
| --- | --- | --- |
| `hero` | `public/cinematic/hero-district-v6.png` (approved, 3840x2160) | `hero-district-v5.png` |
| `liquidity-pools` | `public/cinematic/liquidity-pools-cream.png` (approved cream deck) | `liquidity-pools.png` |

## Dropping in the new art

1. Put the file at the path above.
2. Run `npm run images:landing`.
3. Commit the new `public/cinematic/landing/*.webp` and `lib/landing/images.json`.

`npm run lint` runs `check:images`, which fails while a preferred source is on
disk but the manifest still uses the old one, so the swap cannot be half done.

## The plinth panel recolour

The district art has one small red-orange square panel on the plinth's
front-left face; every other panel is gold. The script recolours it before
encoding: fill `#efc46f`, rim `#c99a3e`, the panel's own shading kept. Only
strongly red-orange pixels (hue 340 to 32 degrees, saturation 0.3 and up)
inside a box on the plinth's front-left face change, so nothing else can. The
box for v6 is wide on purpose (`ASSETS` in the script), because the hue test,
not the box, picks the panel. The v5 art has the same panel and gets the same
treatment, so the page never shows it while v5 is live.

**Visual check for Sky.** After adding v6 and running the script, open
`public/cinematic/landing/hero-1600.webp` and look at the plinth's front-left
face: the small square should be gold like its neighbours, with no red or
orange fringe, and nothing else in the picture should have changed colour.
The script prints how many pixels it recoloured; for v5 it is about 3,900. A
count of 0 on v6 means the panel sits outside the box: widen the v6
`recolour` box in `ASSETS` and run it again.
