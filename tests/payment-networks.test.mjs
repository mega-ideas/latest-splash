/**
 * v2 Phase 3, Sky's decision on which name the Travel Rule confirmation shows
 * for the place the money goes: the payment NETWORK the person knows
 * ("DuitNow" for a Malaysia payout), never the processor or institution behind
 * it, even after a partner agreement is signed.
 *
 * The map from corridor to network name is ONE small module
 * (lib/compliance/payment-networks.ts). It also holds, per corridor, the flag
 * `mustNameReceivingInstitution`: false by default, changed only in code by
 * Splash compliance, never an owner's or a user's setting. Where it is true the
 * confirmation names the real institution next to the network name, and the
 * ban on naming partners has a recorded exception for exactly those corridors.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { TRAVEL_RULE_EXCHANGES } from '../lib/compliance/sumsub.ts';
import { PARTNERS } from '../lib/partners/signed-partners.ts';
import { BANK_COUNTRIES } from '../lib/transfer/payee.ts';
import * as N from '../lib/compliance/payment-networks.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('every corridor has a network name, and the Malaysia one is DuitNow', () => {
  assert.ok(N.CORRIDORS.length >= 6);
  for (const corridor of N.CORRIDORS) {
    const entry = N.PAYMENT_NETWORKS[corridor];
    assert.ok(entry.network.trim().length > 1, `${corridor} has a network name`);
    assert.ok(entry.country.trim().length > 1, `${corridor} has a country name`);
    assert.equal(typeof entry.mustNameReceivingInstitution, 'boolean');
  }
  assert.equal(N.networkNameOf('MY'), 'DuitNow');
  assert.equal(N.networkNameOf(' my '), 'DuitNow', 'cleaned like every country code');
  assert.equal(N.networkNameOf('ZZ'), null);
  // Every country a bank payout can go to, and every country an exchange we can pay is in, is a corridor here.
  for (const c of BANK_COUNTRIES) assert.ok(N.networkNameOf(c.country), `${c.country} (bank payout) has a network name`);
  for (const id of TRAVEL_RULE_EXCHANGES) {
    assert.ok(N.EXCHANGE_CORRIDORS[id], `${id} is in a corridor`);
    assert.ok(N.networkNameOf(N.EXCHANGE_CORRIDORS[id]), `${id}'s corridor has a network name`);
  }
});

test('the bank payout list reads its network names from this module, so there is one place', () => {
  for (const c of BANK_COUNTRIES) assert.equal(c.rails, N.networkNameOf(c.country), `${c.country}`);
});

test('no corridor must name its receiving institution by default, and the list of exceptions is empty', () => {
  for (const corridor of N.CORRIDORS) assert.equal(N.PAYMENT_NETWORKS[corridor].mustNameReceivingInstitution, false, corridor);
  assert.deepEqual([...N.institutionNamingExceptions()], []);
  assert.deepEqual([...N.INSTITUTION_NAMING_EXCEPTIONS], []);
});

test('the words name the network and never the processor or institution, signed or not', () => {
  const processors = Object.values(PARTNERS).flatMap((p) => [p.name, p.role]);
  for (const id of TRAVEL_RULE_EXCHANGES) {
    const words = N.networkWords(id);
    assert.ok(words.network.length > 1);
    assert.equal(words.institution, null);
    for (const name of processors) assert.ok(!words.text.includes(name), `${id}: "${words.text}" does not carry ${name}`);
    assert.ok(words.text.includes(words.network));
  }
  assert.equal(N.networkWords('hata').text, 'DuitNow', 'Malaysia: DuitNow, not Fiuu and not the exchange');
  assert.ok(!N.networkWords('hata').text.includes('Fiuu'));
  // A signed agreement changes nothing: this function does not even take the list of signed partners.
  assert.equal(N.networkWords.length <= 2, true);
});

test('a flagged corridor names the real institution next to the network; an unflagged one never does', () => {
  const flagged = { ...N.PAYMENT_NETWORKS, MY: { ...N.PAYMENT_NETWORKS.MY, mustNameReceivingInstitution: true } };
  const my = N.networkWords('hata', flagged);
  assert.equal(my.institution, PARTNERS.hata.name);
  assert.ok(my.text.includes('DuitNow') && my.text.includes(PARTNERS.hata.name), my.text);
  assert.ok(my.text.indexOf('DuitNow') < my.text.indexOf(PARTNERS.hata.name), 'the network first, the institution next to it');
  // The same table leaves every other corridor alone.
  for (const id of TRAVEL_RULE_EXCHANGES.filter((e) => e !== 'hata')) {
    const words = N.networkWords(id, flagged);
    assert.equal(words.institution, null, id);
    assert.ok(!words.text.includes(PARTNERS[id].name), id);
  }
  assert.deepEqual([...N.institutionNamingExceptions(flagged)], ['MY'], 'the recorded exception is exactly the flagged corridors');
  assert.equal(N.mustNameInstitution('MY', flagged), true);
  assert.equal(N.mustNameInstitution('PH', flagged), false);
  assert.equal(N.mustNameInstitution('MY'), false);
});

test('the flag is code, not a setting: nothing reads it from the database, the environment or a request', () => {
  const source = read('lib/compliance/payment-networks.ts');
  assert.match(source, /mustNameReceivingInstitution/);
  assert.doesNotMatch(source, /process\.env|getEnv|drizzle|fetch\(/);
  for (const path of ['lib/db/schema.ts', 'lib/env.ts']) assert.doesNotMatch(read(path), /mustNameReceivingInstitution|must_name_receiving/i, `${path} holds no such setting`);
  // The one place the screen's words are made no longer asks which partners are signed.
  const words = read('lib/compliance/exchange-disclosure.ts');
  assert.doesNotMatch(words.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /partnerLabel/);
});

test('the exception and the flag are recorded in the docs for Sebastian and compliance', () => {
  for (const path of ['docs/v2/phase3-team-roles.md', 'SECURITY.md']) {
    const text = read(path);
    assert.match(text, /mustNameReceivingInstitution/, `${path} records the flag`);
    assert.match(text, /DuitNow/, `${path} gives the Malaysia example`);
  }
  assert.match(read('SECURITY.md'), /confirm the wording[\s\S]{0,200}(data-protection|data protection)[\s\S]{0,120}Travel Rule/i);
});
