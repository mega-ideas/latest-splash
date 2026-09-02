import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTimeline, settlementPath } from '../lib/settlement/delivery-states.ts';

test('settlement path follows the rail: A sui-native, B cctp, C wire', () => {
  assert.deepEqual(settlementPath('sui-native'), [
    'INTENT_CREATED', 'FUNDED', 'SETTLED_ON_SUI', 'DELIVERED_TO_EXCHANGE', 'CONVERTED', 'PAID_OUT', 'CONFIRMED',
  ]);
  assert.deepEqual(settlementPath('cctp').slice(3, 7), ['BURNED', 'ATTESTED', 'MINTED', 'DELIVERED']);
  assert.deepEqual(settlementPath('wire').slice(3, 5), ['WIRE_SENT', 'WIRE_CONFIRMED']);
});

test('timeline marks observed hops done, the next hop current, the rest todo', () => {
  const nodes = buildTimeline('sui-native', [
    { state: 'INTENT_CREATED', at: '2026-09-02T00:00:00Z' },
    { state: 'FUNDED', at: '2026-09-02T00:01:00Z' },
    { state: 'SETTLED_ON_SUI', at: '2026-09-02T00:01:01Z' },
  ]);
  assert.deepEqual(nodes.map((n) => n.status), ['done', 'done', 'done', 'current', 'todo', 'todo', 'todo']);
  assert.equal(nodes[2].at, '2026-09-02T00:01:01Z');
});

test('a RETURNED branch is inserted after the last observed hop and ends the path', () => {
  const nodes = buildTimeline('sui-native', [
    { state: 'INTENT_CREATED' },
    { state: 'FUNDED' },
    { state: 'SETTLED_ON_SUI' },
    { state: 'DELIVERED_TO_EXCHANGE' },
    { state: 'RETURNED', at: '2026-09-02T02:00:00Z' },
  ]);
  const branchIndex = nodes.findIndex((n) => n.state === 'RETURNED');
  assert.equal(branchIndex, 4);
  assert.equal(nodes[branchIndex].status, 'branch');
  assert.equal(nodes[3].status, 'done');
  assert.ok(nodes.slice(branchIndex + 1).every((n) => n.status === 'todo'));
  assert.equal(nodes.some((n) => n.status === 'current'), false, 'nothing is in progress after a return');
});

test('a HOP_STUCK branch on the cctp rail keeps the earlier hops done', () => {
  const nodes = buildTimeline('cctp', [
    { state: 'INTENT_CREATED' },
    { state: 'FUNDED' },
    { state: 'SETTLED_ON_SUI' },
    { state: 'BURNED' },
    { state: 'HOP_STUCK' },
  ]);
  assert.deepEqual(nodes.slice(0, 4).map((n) => n.status), ['done', 'done', 'done', 'done']);
  assert.equal(nodes[4].state, 'HOP_STUCK');
  assert.equal(nodes[4].status, 'branch');
});

test('a confirmed run has every hop done and none current', () => {
  const path = settlementPath('wire');
  const nodes = buildTimeline('wire', path.map((state) => ({ state })));
  assert.ok(nodes.every((n) => n.status === 'done'));
});
