/**
 * The three loops' art in brand colours (the step B review, brief D14).
 *
 * Red before green: the loop illustrations ship as their PNG originals with
 * red-orange details (Supply's "%" tile and its label, Settle's clock, Save's
 * Approve button), though the cards around them are brand colours. The image
 * pipeline (scripts/landing-images.mjs) now shifts every red-orange pixel of
 * that art to the gold family, keeping its shading and its soft edges, and
 * ships WebP; the landing asks the pipeline for it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const LOOPS = ['loop-settle', 'loop-save', 'loop-supply'];

function hue([r, g, b]) {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

test('the gold shift turns red-orange gold, edges included, and leaves gold, teal and cream alone', async () => {
  const { goldShift } = await import('../scripts/landing-images.mjs');
  const pixels = {
    red: [229, 115, 90, 255],
    fringe: [244, 196, 186, 255], // a red edge blended into white
    gold: [239, 196, 111, 255],
    teal: [13, 99, 112, 255],
    cream: [255, 250, 244, 255],
    clear: [230, 90, 70, 0],
  };
  const names = Object.keys(pixels);
  const data = Buffer.from(names.flatMap((n) => pixels[n]));
  const changed = goldShift(data, names.length, 1);
  const at = (n) => [...data.subarray(names.indexOf(n) * 4, names.indexOf(n) * 4 + 4)];
  assert.equal(changed, 2, 'the red and its fringe');
  for (const n of ['red', 'fringe']) {
    const h = hue(at(n));
    assert.ok(h >= 36 && h <= 46, `${n} is gold now (hue ${h.toFixed(1)}): ${at(n)}`);
  }
  for (const n of ['gold', 'teal', 'cream', 'clear']) assert.deepEqual(at(n), pixels[n], `${n} is untouched`);
});

test('the loop art ships as gold-shifted WebP from the pipeline, never as the PNG originals', async () => {
  const { manifestProblems } = await import('../scripts/landing-images.mjs');
  assert.deepEqual(manifestProblems(), []);
  const manifest = JSON.parse(readFileSync('lib/landing/images.json', 'utf8'));
  for (const key of LOOPS) {
    const entry = manifest[key];
    assert.ok(entry, `${key} is in the manifest`);
    assert.match(entry.source, /^isometric\/loop-/);
    assert.ok(entry.goldShiftedPixels > 1000, `${key}: its red-orange details were shifted (${entry.goldShiftedPixels})`);
    for (const v of entry.variants) assert.match(v.src, /^\/cinematic\/landing\/loop-.+\.webp$/);
  }
  const landing = readFileSync('components/IsometricLanding.tsx', 'utf8');
  assert.doesNotMatch(landing, /loop-(?:settle|save|supply)[\w-]*\.png/, 'no PNG original is requested');
  for (const key of LOOPS) assert.match(landing, new RegExp(`landingImage\\('${key}'\\)`));
});
