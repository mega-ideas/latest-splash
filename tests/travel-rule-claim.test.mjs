/**
 * v2 Phase 3, the Travel Rule send when a name switch changes while a payment is
 * being sent.
 *
 * A message that has not gone yet is sent in the form the switches allow at the
 * moment of sending, so a person who stops sharing their name before it goes is
 * not named. To do that, a row still waiting to be sent has its request hash
 * replaced by the private form's. An independent review found the claim that
 * moves the row from "preparing" to "sending" did not name the hash it was
 * claiming: caller A could read the row with the named hash, caller B could replace
 * it with the private one, and A could still claim and send the NAMED message
 * while the row recorded the private hash.
 *
 * The claim now names the hash it read. A claim that finds the row changed under
 * it sends nothing and asks the caller to try again, which re-reads the switches.
 *
 * PGlite with every migration. Nothing reaches a network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import * as schema from '../lib/db/schema.ts';
import { sendTravelRule } from '../lib/server/travel-rule-transfers.ts';
import { migratedDb } from './helpers/store-db.mjs';

const T0 = new Date('2026-11-02T09:00:00Z');
const INTENT = 'tx_key_000001';
const input = (purpose) => ({
  intentId: INTENT,
  orgId: 'acme',
  applicantId: 'applicant-001',
  at: T0,
  amountMinor: 1_250_500_000n,
  originator: { legalName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', country: 'MY', town: 'Kuala Lumpur', street: 'Jalan Ampang', postCode: '50450', walletAddress: `0x${'11'.repeat(32)}` },
  beneficiary: { legalName: 'Dela Cruz Trading Corp', registrationNumber: 'CS201912345', country: 'PH', town: 'Makati', exchange: 'pdax', depositAddress: `0x${'d3'.repeat(32)}` },
  purpose,
  signingRequestId: null,
  createdBy: 'u-staff',
});
const NAMED = 'Sent by Aisha Rahman (CFO): Paying a supplier invoice';
const PRIVATE = 'Sent by Acme Trading Sdn Bhd: Paying a supplier invoice';

/** The first `returning()` on this table runs `mutate` first: the moment another caller gets in between the read and the claim. */
function racing(db, mutate) {
  let armed = false;
  const wrap = (builder) =>
    new Proxy(builder, {
      get(target, prop) {
        const value = target[prop];
        if (prop === 'returning' && armed) {
          return async (...args) => {
            armed = false;
            await mutate();
            return value.apply(target, args);
          };
        }
        if (typeof value !== 'function') return value;
        return (...args) => {
          const out = value.apply(target, args);
          return out && typeof out === 'object' && out !== target && typeof out.returning === 'function' ? wrap(out) : out === target ? wrap(out) : out;
        };
      },
    });
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'update') return (table) => (armed && table === schema.travelRuleTransfers ? wrap(target.update(table)) : target.update(table));
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, arm: () => { armed = true; } };
}

test('a claim that finds the row changed under it sends nothing, and the row keeps the hash of the message that is sent', async () => {
  const { db } = await migratedDb();
  const sent = [];
  let fail = true;
  const provider = {
    id: 'sandbox',
    sandbox: true,
    async submitOutbound(message) {
      if (fail) throw new Error('transient');
      sent.push(message.purpose);
      return { provider: 'sandbox', sandbox: true, reference: 'sandbox_tr_1', status: 'submitted' };
    },
  };
  // The first send fails after the row was stored in the named form: it waits, unsent.
  const first = await sendTravelRule({ db, provider, orgId: 'acme', now: () => T0 }, input(NAMED));
  assert.equal(first.ok, false);
  const [waiting] = await db.select().from(schema.travelRuleTransfers).where(eq(schema.travelRuleTransfers.paymentRef, INTENT));
  assert.equal(waiting.status, 'preparing');
  fail = false;

  // Caller A holds the named form. Just before A claims, caller B turns the row into the private form.
  const privateOnly = await (async () => {
    const probe = await migratedDb();
    const echo = { id: 'sandbox', sandbox: true, async submitOutbound() { throw new Error('x'); } };
    await sendTravelRule({ db: probe.db, provider: echo, orgId: 'acme', now: () => T0 }, input(PRIVATE));
    const [row] = await probe.db.select().from(schema.travelRuleTransfers);
    return row.requestHash;
  })();
  const race = racing(db, async () => {
    await db.update(schema.travelRuleTransfers).set({ requestHash: privateOnly }).where(eq(schema.travelRuleTransfers.paymentRef, INTENT));
  });
  race.arm();
  const a = await sendTravelRule({ db: race.db, provider, orgId: 'acme', now: () => T0 }, input(NAMED));
  assert.deepEqual(sent, [], 'the named message was not sent');
  assert.equal(a.ok, false);
  assert.equal(a.status, 409);
  assert.equal(a.code, 'travel_rule_in_progress', 'try again: the switches are read again');

  // The retry, now in the private form, goes.
  const b = await sendTravelRule({ db, provider, orgId: 'acme', now: () => T0 }, input(PRIVATE));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual(sent, [PRIVATE]);
  const [row] = await db.select().from(schema.travelRuleTransfers).where(eq(schema.travelRuleTransfers.paymentRef, INTENT));
  assert.equal(row.requestHash, privateOnly, 'the row records the hash of what was sent');
});

test('the claim names the hash it read', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../lib/server/travel-rule-transfers.ts', import.meta.url), 'utf8');
  const claim = source.slice(source.indexOf('Claim the send'), source.indexOf('const back ='));
  assert.match(claim, /eq\(travelRuleTransfers\.requestHash, requestHash\)/);
});
