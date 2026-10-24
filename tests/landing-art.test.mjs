/**
 * The landing's closing art shows no fee it does not render from the
 * schedule (the A1 review, L8).
 *
 * public/isometric/payments.svg is a receipt drawn as a raster inside an
 * SVG. It had "0.8%" baked into its Fee row, a rate no schedule ever set and
 * no change to the schedule could correct. What is pinned here:
 *   * the pixels where that rate was drawn carry no glyph: the Fee row there
 *     is the row's own fill;
 *   * the art still says it was generated with AI (its metadata is kept);
 *   * the Fee row's value is written over the art by the landing, from the
 *     schedule in force: Splash's bank fee, or "None yet" while the fees
 *     are off (PricingSummary.bankFee), never a typed rate.
 *
 * The PNG is decoded here with zlib alone (8-bit greyscale or RGB, not
 * interlaced, the five row filters), so the test needs no image library.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

const SVG = readFileSync('public/isometric/payments.svg', 'utf8');

/** The PNGs embedded in the SVG, in document order. */
function embeddedPngs(svg) {
  return [...svg.matchAll(/xlink:href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g)].map((m) => Buffer.from(m[1], 'base64'));
}

/** { width, height, channels, pixels } of an 8-bit, non-interlaced greyscale or RGB PNG. */
function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'a PNG signature');
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString('latin1');
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = data.subarray(8, 13);
      assert.equal(depth, 8, 'an 8-bit PNG');
      assert.equal(interlace, 0, 'not interlaced');
      channels = { 0: 1, 2: 3 }[colour];
      assert.ok(channels, `colour type ${colour} is greyscale or RGB`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else assert.equal(filter, 0, `row filter ${filter}`);
      pixels[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** Pixels in the box, inclusive, darker than `below` in luminance: glyph ink, not the row's fill. */
function inkIn({ width, channels, pixels }, [x0, y0, x1, y1], below) {
  let ink = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * width + x) * channels;
      const lum = channels === 1 ? pixels[i] : 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      if (lum < below) ink += 1;
    }
  }
  return ink;
}

// Where "0.8%" was drawn on the Fee row, in the colour raster's own pixels.
// Its glyphs are a dark green (luminance about 80) on a tan row (about 199).
const BAKED_RATE = [444, 638, 518, 702];
// The row's own "Fee" label, which stays: the same ink, so the measure bites.
const FEE_LABEL = [244, 758, 294, 806];

test("the closing art's Fee row carries no baked rate", () => {
  const pngs = embeddedPngs(SVG);
  assert.equal(pngs.length, 2, 'the luminance mask and the colour raster');
  const art = decodePng(pngs[1]);
  assert.deepEqual([art.width, art.height], [610, 980]);
  assert.ok(inkIn(art, FEE_LABEL, 150) > 200, 'the "Fee" label is still drawn, in ink this measure sees');
  assert.equal(inkIn(art, BAKED_RATE, 150), 0, 'no glyph is left where "0.8%" was');
});

test('the art still says it was generated with AI', () => {
  assert.match(SVG, /ContainsAiGeneratedContent/);
  assert.match(SVG, /c2pa:manifest/);
});

test("the landing writes the Fee row's value from the schedule, onto the art", () => {
  const landing = readFileSync('components/IsometricLanding.tsx', 'utf8');
  assert.match(landing, /src="\/isometric\/payments\.svg"/, 'the art is still the receipt');
  assert.match(landing, /<ReceiptArtFee value=\{pricing\.bankFee\} \/>/, "the value is the schedule's bank fee, or None yet");
  const fn = landing.slice(landing.indexOf('function ReceiptArtFee'), landing.indexOf('function ReceiptArtFee') + 1200);
  assert.match(fn, /<text[^>]*>\{value\}<\/text>/, 'the overlay prints the value it is handed');
  assert.doesNotMatch(fn, /\d\.\d+\s*%|\d+\s*bps/, 'and types no rate');
  assert.match(fn, /viewBox="0 0 1086 814\.5"/, "in the art's own coordinates");
});
