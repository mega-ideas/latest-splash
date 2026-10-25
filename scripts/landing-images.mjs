#!/usr/bin/env node
/**
 * The landing's two large pieces of art, made light enough to ship.
 *
 *   node scripts/landing-images.mjs          write the WebP files and the manifest
 *   node scripts/landing-images.mjs --check  fail if the manifest is out of date
 *
 * The PNG originals in public/cinematic/ are 1-6 MB each (hero-district-v5
 * is 3.9 MB) and never reach a browser: no component names them. What ships
 * is WebP with its alpha kept, at 1600 px and 2400 px wide, plus a crop for
 * phones, written to public/cinematic/landing/. The components read
 * lib/landing/images.json (written here) and hand next/image a loader that
 * picks the file for each width in `sizes`, so the optimizer never touches
 * the originals either.
 *
 * Each piece names the sources it accepts, best first. Sky adds the approved
 * art when it is ready (hero-district-v6.png, liquidity-pools-cream.png);
 * until then the current art is used. Dropping a new file in and running
 * this script is the whole change: the manifest records which source was
 * used, and the page follows it.
 *
 * A width is never enlarged: a source narrower than 2400 px gives the widths
 * it can fill, and the manifest lists only the widths that exist.
 *
 * The hero's red-orange plinth panel. The approved district art has one
 * small red-orange square on the plinth's front-left face; every other panel
 * is gold. Before the art is used that square is recoloured to the gold of
 * the others: fill #efc46f, rim #c99a3e, its shading kept. The recolour only
 * touches strongly red-orange pixels inside a box on the plinth's front-left
 * face, so nothing else in the picture can change colour. It is listed for
 * Sky to check by eye (docs/design/landing-images.md), because a box drawn
 * for a picture nobody here has seen is a guess until someone looks.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUT_DIR = 'public/cinematic/landing';
export const MANIFEST = 'lib/landing/images.json';
export const WIDTHS = [1600, 2400];
/** The hero at 1600 px must weigh less than this (brief section 6). */
export const HERO_BUDGET_BYTES = 400 * 1024;

const GOLD_FILL = [0xef, 0xc4, 0x6f];
const GOLD_RIM = [0xc9, 0x9a, 0x3e];

/**
 * The pieces. `recolour` is the box, as fractions of the picture, in which a
 * red-orange pixel becomes gold. `phone` is the crop for a 390 px screen.
 */
export const ASSETS = [
  {
    key: 'hero',
    budgetBytes: HERO_BUDGET_BYTES,
    sources: [
      {
        file: 'public/cinematic/hero-district-v6.png',
        // The approved 3840x2160 art: the plinth's front-left face. Wide on
        // purpose; the hue test, not the box, picks the panel.
        recolour: { x0: 0.08, y0: 0.5, x1: 0.42, y1: 0.9 },
        phone: { x0: 0.2, y0: 0.06, x1: 0.8, y1: 0.94 },
      },
      {
        file: 'public/cinematic/hero-district-v5.png',
        // The same panel on the current art, left of the first gold panel.
        recolour: { x0: 0.195, y0: 0.61, x1: 0.235, y1: 0.7 },
        phone: { x0: 0.17, y0: 0.06, x1: 0.83, y1: 0.94 },
      },
    ],
  },
  {
    key: 'liquidity-pools',
    sources: [
      { file: 'public/cinematic/liquidity-pools-cream.png', phone: { x0: 0.12, y0: 0, x1: 0.88, y1: 1 } },
      { file: 'public/cinematic/liquidity-pools.png', phone: { x0: 0.12, y0: 0, x1: 0.88, y1: 1 } },
    ],
  },
  // The three loops' art (the step B review): small cards, so 720 and
  // 1448 px. Their red-orange details (Supply's "%" tile and label, Settle's
  // clock, Save's Approve button) are shifted to gold over the whole picture
  // (goldShift below); nothing else in this art is red.
  ...[
    ['loop-settle', 'public/isometric/loop-settle-v3.png'],
    ['loop-save', 'public/isometric/loop-save-v3.png'],
    ['loop-supply', 'public/isometric/loop-supply.png'],
  ].map(([key, file]) => ({
    key,
    widths: [720, 1448],
    sources: [{ file, goldShift: true, phone: { x0: 0, y0: 0, x1: 1, y1: 1 } }],
  })),
];

// ─── The recolour, on raw RGBA, so a test can run it on a planted square ───

function hsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

/** Red to orange, saturated and not dark: the panel, never the gold (about 40 degrees) or the ink. */
export function isRedOrange(r, g, b) {
  const { h, s, v } = hsv(r, g, b);
  return (h <= 32 || h >= 340) && s >= 0.3 && v >= 0.25;
}

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Recolour the red-orange pixels inside `box` (fractions) of an RGBA buffer,
 * in place. The panel's own shading is kept: each pixel's brightness against
 * the panel's median sets how light its gold is, and the darker edge pixels
 * take the rim gold. Returns how many pixels changed.
 */
export function recolourPanel(data, width, height, box) {
  const x0 = Math.max(0, Math.floor(box.x0 * width));
  const x1 = Math.min(width, Math.ceil(box.x1 * width));
  const y0 = Math.max(0, Math.floor(box.y0 * height));
  const y1 = Math.min(height, Math.ceil(box.y1 * height));
  const hits = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 8) continue;
      if (isRedOrange(data[i], data[i + 1], data[i + 2])) hits.push(i);
    }
  }
  if (hits.length === 0) return 0;
  const lums = hits.map((i) => luminance(data[i], data[i + 1], data[i + 2])).sort((a, b) => a - b);
  const median = lums[Math.floor(lums.length / 2)] || 1;
  for (const i of hits) {
    const ratio = luminance(data[i], data[i + 1], data[i + 2]) / median;
    const base = ratio < 0.82 ? GOLD_RIM : GOLD_FILL;
    const shade = Math.min(1.12, Math.max(0.6, ratio < 0.82 ? ratio / 0.82 : ratio));
    for (let c = 0; c < 3; c += 1) data[i + c] = Math.max(0, Math.min(255, Math.round(base[c] * shade)));
  }
  return hits.length;
}

const GOLD_HUE = hsv(...GOLD_FILL).h;

function fromHsv(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : [0, c, x];
  return [r, g, b].map((t) => Math.round((t + m) * 255));
}

/**
 * Shift every red-orange pixel of an RGBA buffer to the gold hue, in place.
 * Unlike recolourPanel this keeps each pixel's own saturation and
 * brightness, so a red edge blended into white becomes a gold edge blended
 * into white, with no pink fringe. Gold (about 40 degrees), teal, cream and
 * transparent pixels are left alone. Returns how many pixels changed.
 */
export function goldShift(data, width, height) {
  let changed = 0;
  for (let i = 0; i < width * height * 4; i += 4) {
    if (data[i + 3] < 8) continue;
    const { h, s, v } = hsv(data[i], data[i + 1], data[i + 2]);
    if (!((h <= 28 || h >= 340) && s >= 0.12 && v >= 0.25)) continue;
    const [r, g, b] = fromHsv(GOLD_HUE, Math.min(1, s * 0.95), v);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    changed += 1;
  }
  return changed;
}

// ─── The files ─────────────────────────────────────────────────────────────

function pickSource(asset, root) {
  return asset.sources.find((s) => existsSync(path.join(root, s.file))) ?? null;
}

async function encodeUnder(sharp, input, width, budget) {
  // Quality steps down until the file fits its budget; alpha stays exact.
  for (const quality of [82, 76, 70, 64, 58, 52, 46]) {
    const buf = await sharp(input.data, { raw: input.info })
      .resize({ width, withoutEnlargement: true })
      .webp({ quality, alphaQuality: 90, effort: 6, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    if (!budget || buf.data.length <= budget) return { ...buf, quality };
  }
  throw new Error(`cannot fit ${width}px under ${budget} bytes`);
}

export async function build({ root = process.cwd(), write = true } = {}) {
  const { default: sharp } = await import('sharp');
  const manifest = {};
  for (const asset of ASSETS) {
    const source = pickSource(asset, root);
    if (!source) throw new Error(`${asset.key}: none of ${asset.sources.map((s) => s.file).join(', ')} exists`);
    const raw = await sharp(path.join(root, source.file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const recoloured = source.recolour ? recolourPanel(raw.data, raw.info.width, raw.info.height, source.recolour) : 0;
    const shifted = source.goldShift ? goldShift(raw.data, raw.info.width, raw.info.height) : 0;
    const input = { data: raw.data, info: raw.info };

    const sourceHash = createHash('sha256').update(readFileSync(path.join(root, source.file))).digest('hex').slice(0, 16);
    const widths = [...new Set((asset.widths ?? WIDTHS).map((w) => Math.min(w, raw.info.width)))];
    const variants = [];
    for (const width of widths) {
      const budget = width <= 1600 ? asset.budgetBytes : undefined;
      const out = await encodeUnder(sharp, input, width, budget);
      const file = `${OUT_DIR}/${asset.key}-${out.info.width}.webp`;
      if (write) {
        mkdirSync(path.join(root, OUT_DIR), { recursive: true });
        writeFileSync(path.join(root, file), out.data);
      }
      variants.push({ src: `/${file.replace(/^public\//, '')}`, width: out.info.width, height: out.info.height, bytes: out.data.length });
    }

    const crop = source.phone;
    const left = Math.round(crop.x0 * raw.info.width);
    const top = Math.round(crop.y0 * raw.info.height);
    const cropped = await sharp(raw.data, { raw: raw.info })
      .extract({ left, top, width: Math.round((crop.x1 - crop.x0) * raw.info.width), height: Math.round((crop.y1 - crop.y0) * raw.info.height) })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const phone = await encodeUnder(sharp, { data: cropped.data, info: cropped.info }, 900, asset.budgetBytes);
    const phoneFile = `${OUT_DIR}/${asset.key}-phone.webp`;
    if (write) writeFileSync(path.join(root, phoneFile), phone.data);

    manifest[asset.key] = {
      source: source.file.replace(/^public\//, ''),
      sourceSha256: sourceHash,
      recolouredPixels: recoloured,
      ...(source.goldShift ? { goldShiftedPixels: shifted } : {}),
      variants,
      phone: { src: `/${phoneFile.replace(/^public\//, '')}`, width: phone.info.width, height: phone.info.height, bytes: phone.data.length },
    };
  }
  if (write) {
    mkdirSync(path.dirname(path.join(root, MANIFEST)), { recursive: true });
    writeFileSync(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return manifest;
}

/** Whether the manifest names the best source on disk, and every file it lists exists. */
export function manifestProblems(root = process.cwd()) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(root, MANIFEST), 'utf8'));
  } catch {
    return [`${MANIFEST} is missing: run node scripts/landing-images.mjs`];
  }
  for (const asset of ASSETS) {
    const entry = manifest[asset.key];
    const best = pickSource(asset, root);
    if (!entry) { problems.push(`${asset.key}: not in the manifest`); continue; }
    if (best && entry.source !== best.file.replace(/^public\//, '')) {
      problems.push(`${asset.key}: ${best.file} is on disk but the manifest still uses ${entry.source}; run node scripts/landing-images.mjs`);
    }
    for (const v of [...entry.variants, entry.phone]) {
      const file = path.join(root, 'public', v.src);
      if (!existsSync(file)) problems.push(`${asset.key}: ${v.src} is missing`);
      else if (statSync(file).size !== v.bytes) problems.push(`${asset.key}: ${v.src} is not the file the manifest describes`);
    }
  }
  return problems;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--check')) {
    const problems = manifestProblems();
    if (problems.length) {
      console.error(`Landing images are out of date:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log('Landing images match their sources.');
  } else {
    const manifest = await build();
    for (const [key, entry] of Object.entries(manifest)) {
      const sizes = entry.variants.map((v) => `${v.width}px ${(v.bytes / 1024).toFixed(0)} KB`).join(', ');
      console.log(`${key}: from ${entry.source} (${entry.recolouredPixels} pixels recoloured): ${sizes}; phone ${(entry.phone.bytes / 1024).toFixed(0)} KB`);
    }
  }
}
