/**
 * No partner is named in shipped copy until its agreement is signed (brief
 * §0.8, §3.9). The list is `SIGNED_PARTNERS`, server-side, empty by default.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const lib = () => import('../lib/partners/signed-partners.ts');

test('by default nobody is named: every partner is described by its role', async () => {
  const { parseSignedPartners, partnerLabel, PARTNERS, PARTNER_IDS } = await lib();
  const none = parseSignedPartners(undefined);
  assert.equal(none.size, 0);
  assert.equal(parseSignedPartners('').size, 0);
  assert.equal(parseSignedPartners('   ').size, 0);
  for (const id of PARTNER_IDS) {
    const label = partnerLabel(id, none);
    assert.equal(label, PARTNERS[id].role);
    assert.ok(!label.includes(PARTNERS[id].name), `${id}: the role does not smuggle in the name`);
  }
});

test('a signed partner is named, and only that one', async () => {
  const { parseSignedPartners, partnerLabel, mayName } = await lib();
  const signed = parseSignedPartners('pdax, Sumsub');
  assert.deepEqual([...signed].sort(), ['pdax', 'sumsub']);
  assert.equal(partnerLabel('pdax', signed), 'PDAX');
  assert.equal(partnerLabel('sumsub', signed), 'Sumsub');
  assert.equal(partnerLabel('durianpay', signed), 'our Indonesia payout partner');
  assert.equal(mayName('hata', signed), false);
});

test('an unknown partner id is refused, not skipped', async () => {
  const { parseSignedPartners } = await lib();
  assert.throws(() => parseSignedPartners('pdax,pdx'), /pdx/);
});

test('every partner the decisions name is in the registry', async () => {
  const { PARTNERS } = await lib();
  // D4 payout routes, D5 wallet recipients, D7 funding, D8 compliance, D9 treasury.
  for (const id of ['pdax', 'durianpay', 'hata', 'fiuu', 'tokocrypto', 'bitkub', 'halliday', 'stripe', 'transfi', 'sumsub', 'elliptic', 'halogen', 'ondo']) {
    assert.ok(id in PARTNERS, `${id} is registered`);
  }
});

test('SIGNED_PARTNERS is declared in lib/env.ts, optional, and read only server-side', async () => {
  const env = await readFile(new URL('../lib/env.ts', import.meta.url), 'utf8');
  assert.match(env, /SIGNED_PARTNERS: opt\(/);
  const server = await readFile(new URL('../lib/server/signed-partners.ts', import.meta.url), 'utf8');
  assert.match(server, /^import 'server-only';/m);
});
