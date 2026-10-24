/**
 * v2 Phase 4, step A review: the independent reviewer's findings on the
 * landing's hero, product section, partners and how it works.
 *
 * Red before green: on 4681d96 the hero says "KYB on both sides" (a wallet
 * recipient is cleared by an ownership proof, not KYB), the rate chip says
 * "held 30s" forever, the debit row says "fees included" but leaves out the
 * partner fee, nothing reads the pilot access requests back, four sections
 * outside Platform still draw a grid, the phone hero preloads the hidden
 * desktop art, the "Settled" chip is 4.25:1, the toggles announce radios
 * that ignore the arrow keys, the access form can hang, the signup intent
 * has three labels, and phones get the desktop sections stacked.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (p) => readFileSync(p, 'utf8');

function code(p) {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

function filesUnder(dir, re = /\.(tsx?|mjs)$/) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) out.push(...filesUnder(full, re));
    else if (re.test(entry.name)) out.push(full);
  }
  return out;
}

/* ── Hero ──────────────────────────────────────────────────────────────── */

test('the hero proof line holds for bank and wallet recipients alike', () => {
  const hero = code('components/landing/SettlementCinematic.tsx');
  assert.doesNotMatch(hero, /KYB on both sides/, 'a wallet recipient is cleared by an ownership proof, not KYB');
  assert.match(hero, /Every recipient verified/);
});

test('on a phone the hero preloads the phone crop, and never renders the hidden desktop art', () => {
  const hero = code('components/landing/SettlementCinematic.tsx');
  assert.match(hero, /\{!phone \? \(\s*<div className="cin-static-stage"/, 'the stage (and its priority image) is not rendered on a phone');
  const phoneBlock = hero.slice(hero.indexOf('cin-phone-object'), hero.indexOf('cin-phone-object') + 600);
  assert.match(phoneBlock, /\bpriority\b/, 'the phone crop is the LCP image there, so it is preloaded');
  assert.match(hero, /<StaticCinematic[^>]*phone=\{phoneLayout\}/);
});

/* ── The rate chip ─────────────────────────────────────────────────────── */

test('the rate chip counts down from the quote TTL and says when the rate has expired', async () => {
  const { rateChip, formatRate } = await import('../lib/landing/calculator.ts');
  assert.deepEqual(rateChip({ ttlSeconds: 30 }, 0), { state: 'held', secondsLeft: 30 });
  assert.deepEqual(rateChip({ ttlSeconds: 30 }, 12_400), { state: 'held', secondsLeft: 18 });
  assert.deepEqual(rateChip({ ttlSeconds: 30 }, 30_000), { state: 'expired', secondsLeft: 0 });
  assert.deepEqual(rateChip({ ttlSeconds: 30 }, 95_000), { state: 'expired', secondsLeft: 0 });
  assert.equal(formatRate('16250'), '16,250', 'the IDR rate is grouped');
  assert.equal(formatRate('56.5'), '56.5');
  assert.equal(formatRate('1234567.125'), '1,234,567.125');

  const product = code('components/landing/ProductSection.tsx');
  assert.doesNotMatch(product, /held \{quote!?\.ttlSeconds\}s/, 'the chip no longer prints the TTL as a fixed hold');
  assert.match(product, /rateChip\(/);
  assert.match(product, /IntersectionObserver/, 'an expired quote is fetched again only while the section is in view');
  assert.match(product, /Rate expired/);
});

/* ── The totals reconcile ──────────────────────────────────────────────── */

test('the calculator lines add up: amount + Splash fee is the debit, amount - partner fee is converted', async () => {
  const { settlementLines } = await import('../lib/landing/calculator.ts');
  const usdc = (n) => BigInt(n) * 1_000_000n;
  const bank = settlementLines({ mode: 'bank', principalMinor: usdc(5000), splashFeeMinor: usdc(10), partnerFeeMinor: usdc(10) });
  assert.equal(bank.debitMinor, usdc(5010));
  assert.equal(bank.convertedMinor, usdc(4990));
  assert.equal(bank.convertedMinor + bank.partnerFeeMinor, usdc(5000), 'converted + partner fee = the amount');
  assert.equal(bank.debitMinor - bank.splashFeeMinor, usdc(5000), 'debit - Splash fee = the amount');

  const unquoted = settlementLines({ mode: 'bank', principalMinor: usdc(5000), splashFeeMinor: 0n, partnerFeeMinor: null });
  assert.equal(unquoted.convertedMinor, null, 'nothing is shown as converted before the partner quotes');
  assert.equal(unquoted.debitMinor, usdc(5000));

  const wallet = settlementLines({ mode: 'wallet', principalMinor: usdc(5000), splashFeeMinor: usdc(5), partnerFeeMinor: usdc(99) });
  assert.equal(wallet.partnerFeeMinor, null, 'a wallet payment has no partner fee');
  assert.equal(wallet.convertedMinor, null);
  assert.equal(wallet.debitMinor, usdc(5005));

  const product = code('components/landing/ProductSection.tsx');
  assert.doesNotMatch(product, /fees included/, 'the debit row does not claim to include a fee it does not');
  assert.match(product, /amount \+ Splash fee/);
  assert.match(product, /deducted before conversion/);
  assert.match(product, /Converted/);
  assert.match(product, /settlementLines\(/);
});

/* ── Pilot access requests reach staff ─────────────────────────────────── */

test('staff can read the pilot access requests, and only staff', () => {
  const page = 'app/admin/(console)/access-requests/page.tsx';
  assert.ok(existsSync(page), 'the staff console has a page for them');
  assert.match(code(page), /listAccessRequestsForStaff\(\)/);
  assert.match(code('app/admin/(console)/layout.tsx'), /href: '\/admin\/access-requests'/, 'the console navigation links to it');

  const route = 'app/api/admin/access-requests/route.ts';
  assert.ok(existsSync(route));
  const text = code(route);
  assert.match(text, /getAdminSession\(\)/, 'the export needs a staff session');
  assert.match(text, /status: 401/);
  assert.doesNotMatch(text, /requireCustomerRequest/);

  for (const file of [...filesUnder('app'), ...filesUnder('components'), ...filesUnder('lib')]) {
    if (file.startsWith('app/admin/') || file.startsWith('app/api/admin/') || file === 'lib/server/access-requests.ts') continue;
    assert.doesNotMatch(read(file), /listAccessRequestsForStaff/, `${file} reads the access requests outside the staff console`);
  }
});

/* ── No grid outside Platform ──────────────────────────────────────────── */

test('no section of the landing draws a background grid except Platform', () => {
  const landing = [code('components/IsometricLanding.tsx'), ...filesUnder('components/landing', /\.tsx$/).map(code)].join('\n');
  const rendered = new Set();
  for (const m of landing.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
    for (const token of (m[1] ?? m[2]).split(/\s+/)) if (/^[a-z][\w-]*$/.test(token)) rendered.add(token);
  }
  const offenders = [];
  for (const file of ['app/globals.css', 'styles/cinematic.css', 'styles/landing-v2.css']) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\d+px,\s*transparent\s+\d+px\)/.test(body)) continue;
      const sel = selector.trim();
      if (/\.iso-operating\b/.test(sel)) continue; // Platform keeps its grid (D14)
      const classes = [...sel.matchAll(/\.([a-z][\w-]*)/g)].map((c) => c[1]);
      if (classes.some((c) => rendered.has(c))) offenders.push(`${file}: ${sel.replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(offenders, []);
});

/* ── Contrast ──────────────────────────────────────────────────────────── */

function hex(value) {
  const h = value.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function luminance([r, g, b]) {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => {
  const [x, y] = [luminance(hex(a)), luminance(hex(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('the desk status chips are at least 4.5:1 at 11 px', () => {
  const tokens = read('styles/tokens.css');
  const token = (name) => (tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)) ?? [])[1];
  const css = read('styles/landing-v2.css');
  for (const tone of ['ok', 'info', 'warn']) {
    const rule = css.match(new RegExp(`\\.pv-chip\\.is-${tone} \\{ color: var\\(--([\\w-]+)\\); background: var\\(--([\\w-]+)\\); \\}`));
    assert.ok(rule, `.pv-chip.is-${tone} uses two tokens`);
    const [fg, bg] = [token(rule[1]), token(rule[2])];
    assert.ok(fg && bg, `${rule[1]} and ${rule[2]} are tokens`);
    assert.ok(ratio(fg, bg) >= 4.5, `${tone}: ${fg} on ${bg} is ${ratio(fg, bg).toFixed(2)}:1`);
  }
});

/* ── Keyboard ──────────────────────────────────────────────────────────── */

test('the two-way toggles are pressed buttons, not radios that ignore the arrow keys', () => {
  for (const file of ['components/landing/ProductSection.tsx', 'components/landing/HowItWorks.tsx']) {
    const text = code(file);
    assert.doesNotMatch(text, /role="radio(group)?"/, `${file} announces no radios`);
    assert.match(text, /aria-pressed=\{/, `${file} uses toggle buttons`);
  }
});

/* ── The access form recovers ──────────────────────────────────────────── */

test('the access form gives up after a timeout and focuses the field the server names', () => {
  const product = code('components/landing/ProductSection.tsx');
  const form = product.slice(product.indexOf('function RequestAccess'), product.indexOf('function Calculator'));
  assert.match(form, /new AbortController\(\)/);
  assert.match(form, /ACCESS_TIMEOUT_MS/);
  assert.match(form, /signal: controller\.signal/);
  assert.match(form, /\.focus\(\)/, 'the invalid field gets focus');
});

/* ── Copy ──────────────────────────────────────────────────────────────── */

test('the product copy claims no more than the product does', () => {
  const product = code('components/landing/ProductSection.tsx');
  assert.doesNotMatch(product, /anyone can check/, 'receipts are shared by link, not public');
  assert.match(product, /a receipt you can share with your supplier/);
  assert.match(product, /The on-chain step settles in one Sui transaction/);
  assert.doesNotMatch(product, /See its fee above/, 'no pointer to a fee that is not shown');
  const css = read('styles/landing-v2.css');
  assert.match(css, /\.pr-list li:last-child:nth-child\(odd\) \{ grid-column: 1 \/ -1; \}/, 'the fifth rail fills its row on two columns');
});

test('one label for the signup intent, and no unused import', () => {
  const landing = code('components/IsometricLanding.tsx');
  const product = code('components/landing/ProductSection.tsx');
  assert.doesNotMatch(landing, /Start sending/);
  assert.doesNotMatch(product, /Start this payment/);
  assert.doesNotMatch(landing, /\bscheduleToWire\b/);
});

/* ── Phones get their own composition (D15) ────────────────────────────── */

test('phones get their own landing composition, not the desktop stacked', () => {
  const css = read('styles/landing-v2.css');
  const phone = css.slice(css.indexOf('/* ── Phone composition'));
  assert.ok(phone.length > 30, 'there is a phone composition block');
  assert.match(phone, /\.pv-actions \{ display: none; \}/, 'the product section opens on the calculator, not a second pair of buttons');
  assert.match(phone, /\.pv-desk \{[^}]*order: -1/, 'the desk peeks out from behind the calculator, above it');
  assert.match(phone, /\.hw-steps-phone \{[^}]*display: grid/, 'the five steps are stacked');
  assert.match(phone, /\.iso-loops-grid \{[^}]*scroll-snap-type: x mandatory/, 'the loop cards swipe');
  assert.match(phone, /\.ps-cta/, 'a sticky bottom CTA');

  const how = code('components/landing/HowItWorks.tsx');
  assert.match(how, /className="hw-steps-phone"/);
  assert.match(how, /STEPS\.map\(\(s, i\) => \(\s*<li/);

  const landing = code('components/IsometricLanding.tsx');
  assert.match(landing, /<PhoneStickyCta/);
  const sticky = code('components/landing/PhoneStickyCta.tsx');
  assert.match(sticky, /IntersectionObserver/);
  assert.match(sticky, /Open payment desk/);
  assert.match(sticky, /safe-area|ps-cta/);
});
