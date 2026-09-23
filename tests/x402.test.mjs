import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeX402Requirement,
  formatX402Amount,
  parseX402Challenge,
  x402SettlementAvailability,
  X402ParseError,
} from '../lib/agent/x402.ts';

/**
 * x402 — the parse-and-explain lane. The shapes follow the x402 spec as the
 * Arbitrum workshop facilitator serves it: a 402 body with x402Version and
 * accepts[] of 'exact' requirements, amounts as decimal strings of base
 * units.
 */

const ARBITRUM_CHALLENGE = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'arbitrum-sepolia',
      maxAmountRequired: '10000',
      resource: 'https://api.example.com/reports/fx-summary',
      description: 'One FX summary report',
      mimeType: 'application/json',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      maxTimeoutSeconds: 120,
      asset: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    },
  ],
};

test('a real Arbitrum challenge parses into exact minor units', () => {
  const parsed = parseX402Challenge(ARBITRUM_CHALLENGE);
  assert.equal(parsed.x402Version, 1);
  assert.equal(parsed.requirements.length, 1);
  const req = parsed.requirements[0];
  assert.equal(req.network, 'arbitrum-sepolia');
  assert.equal(req.maxAmountRequiredMinor, 10000n);
  assert.equal(typeof req.maxAmountRequiredMinor, 'bigint', 'money is bigint minor units, never float');
  assert.equal(req.payTo, ARBITRUM_CHALLENGE.accepts[0].payTo);
});

test('JSON text parses the same as an object, and junk is refused with a reason', () => {
  const parsed = parseX402Challenge(JSON.stringify(ARBITRUM_CHALLENGE));
  assert.equal(parsed.requirements[0].maxAmountRequiredMinor, 10000n);

  assert.throws(() => parseX402Challenge('not json at all'), X402ParseError);
  assert.throws(() => parseX402Challenge({}), /x402Version/);
  assert.throws(() => parseX402Challenge({ x402Version: 1, accepts: [] }), /accepts/);
  assert.throws(
    () => parseX402Challenge({ x402Version: 1, accepts: [{ ...ARBITRUM_CHALLENGE.accepts[0], scheme: 'upto' }] }),
    /unsupported scheme/,
  );
  // A decimal amount is a spec violation and must be refused, never rounded.
  assert.throws(
    () =>
      parseX402Challenge({
        x402Version: 1,
        accepts: [{ ...ARBITRUM_CHALLENGE.accepts[0], maxAmountRequired: '0.01' }],
      }),
    /integer base units/,
  );
});

test('amounts format from base units without float math', () => {
  assert.equal(formatX402Amount(10000n), '0.010000');
  assert.equal(formatX402Amount(1_000_000n), '1.000000');
  assert.equal(formatX402Amount(123_456_789n), '123.456789');
  assert.equal(formatX402Amount(0n), '0.000000');
});

test('the operator summary names the amount, network, payee — and flags an unknown network', () => {
  const [req] = parseX402Challenge(ARBITRUM_CHALLENGE).requirements;
  const line = describeX402Requirement(req);
  assert.match(line, /0\.010000/);
  assert.match(line, /arbitrum-sepolia/);
  assert.match(line, /0x209693Bc6afc0C5328bA36FaF03C514EF312287C/);
  assert.doesNotMatch(line, /no facilitator we know/);

  const odd = describeX402Requirement({ ...req, network: 'dogechain' });
  assert.match(odd, /no facilitator we know/);
});

test('settlement is a refusal with its reasons, not a stub that might succeed', () => {
  const availability = x402SettlementAvailability();
  assert.equal(availability.available, false);
  assert.match(availability.reason, /approved by a named human/);
  assert.match(availability.reason, /session mandate/);
  assert.match(availability.reason, /Sui/);
});

/* ── The Zeke tool: registered on the READ side, quoting, never paying ── */

test('quoteX402Payment dispatches through the agent as a READ, in a truth envelope', async () => {
  const { executeOxwalTool, OXWAL_TOOL_REGISTRY, READ_TOOL_NAMES } = await import('../lib/agent/oxwal.ts');

  assert.ok(READ_TOOL_NAMES.includes('quoteX402Payment'), 'a quote is a read, never a proposal');
  const def = OXWAL_TOOL_REGISTRY.find((tool) => tool.name === 'quoteX402Payment');
  assert.ok(def, 'registered for the model');
  assert.equal(def.category, 'READ');
  assert.match(def.description, /never payment/i);

  const envelope = await executeOxwalTool('quoteX402Payment', {
    challenge: JSON.stringify(ARBITRUM_CHALLENGE),
  });
  assert.equal(envelope.source, 'operator.pasted-challenge', 'the label says where the data came from');
  const data = envelope.data;
  assert.equal(data.status, 'QUOTED');
  assert.equal(data.requirements[0].maxAmountRequiredMinor, '10000', 'minor units travel as strings');
  assert.equal(data.requirements[0].amount, '0.010000');
  assert.equal(data.settlement.available, false);
  assert.match(data.message, /quote, not a payment/);
});

test('a junk challenge through the tool refuses with guidance instead of throwing at the model', async () => {
  const { executeOxwalTool } = await import('../lib/agent/oxwal.ts');
  const envelope = await executeOxwalTool('quoteX402Payment', { challenge: 'hello' });
  assert.equal(envelope.data.status, 'INVALID');
  assert.match(envelope.data.message, /paste the full 402 response body/);
  assert.equal(envelope.data.settlement.available, false, 'even an invalid quote carries the refusal');
});

test('the system prompt tells Zeke it can quote x402 and never pay it', async () => {
  const { readFile } = await import('node:fs/promises');
  const agent = await readFile(new URL('../lib/agent/oxwal.ts', import.meta.url), 'utf8');
  assert.match(agent, /call quoteX402Payment to price and explain it/);
  assert.match(agent, /you can never pay it/);
});
