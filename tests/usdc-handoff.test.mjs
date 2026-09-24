import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseUsdcSendIntent, prepareUsdcHandoff, usdcHandoffFor } from '../lib/agent/usdc-handoff.ts';

/**
 * "Send 500 USDC to Manila Parts": Zeke prepares it, a person sends it.
 * Deterministic, before the model; never a quote, an approval or a signature.
 */

const WALLET_MATCH = {
  id: 'sup_manila',
  name: 'Manila Parts Supply',
  country: 'PH',
  bank: '',
  tier: 'PAYOUT_ONLY',
  payoutMethod: 'WALLET',
  wallet: '0xcccccc…cccccc',
  payable: true,
};

function deps(overrides = {}) {
  const calls = { findRecipient: [] };
  return {
    calls,
    laneState: async () => overrides.state ?? 'REGISTERED',
    findRecipient: async (orgId, name) => {
      calls.findRecipient.push(name);
      return overrides.lookup ?? { status: 'FOUND', match: WALLET_MATCH };
    },
    remainingAllowance: async () => ('remaining' in overrides ? overrides.remaining : 5_000_000_000n),
    feeAddressConfigured: () => overrides.fee ?? true,
  };
}

// ─── Reading the message ────────────────────────────────────────────────────

test('it reads the ways people ask, and only when USDC is said', () => {
  assert.deepEqual(parseUsdcSendIntent('send 500 USDC to Manila Parts'), { amount: '500', name: 'Manila Parts' });
  assert.deepEqual(parseUsdcSendIntent('Please pay 1,250.50 usdc to Cebu Traders.'), { amount: '1250.50', name: 'Cebu Traders' });
  assert.deepEqual(parseUsdcSendIntent('transfer $75 USDC to "Acme"'), { amount: '75', name: 'Acme' });
  assert.deepEqual(parseUsdcSendIntent('send Manila Parts 500 USDC'), { amount: '500', name: 'Manila Parts' });
  assert.deepEqual(parseUsdcSendIntent('send 500 USDC to Manila Parts on Sui'), { amount: '500', name: 'Manila Parts' });
  assert.deepEqual(parseUsdcSendIntent('send 500 USDC to Maria’s Slush wallet'), { amount: '500', name: 'Maria' });

  for (const other of [
    'pay Maria 500',                 // a payout request: the lane rules decide
    'pay Maria 50,000 pesos',
    'send 500 to Manila Parts',      // no USDC said
    'what is my USDC balance?',
    'how much USDC can I send this month',
    '',
  ]) {
    assert.equal(parseUsdcSendIntent(other), null, other);
  }
  assert.equal(parseUsdcSendIntent(`send 5 USDC to ${'x'.repeat(300)}`), null, 'a wall of text is not an instruction');
});

// ─── Prepared ───────────────────────────────────────────────────────────────

test('a saved wallet recipient: fee, total and allowance, and a link that carries only an id and an amount', async () => {
  const d = deps({ remaining: 5_000_000_000n });
  const answer = await usdcHandoffFor('org_1', 'send 500 USDC to Manila Parts', d);
  assert.ok(answer.handoff);
  assert.equal(answer.handoff.href, '/dashboard/send-usdc?to=sup_manila&amount=500&from=zeke');
  assert.deepEqual(answer.handoff.lines, [
    'To Manila Parts Supply · 0xcccccc…cccccc',
    'Amount 500.00 USDC',
    'Splash fee 4.00 USDC, added on top',
    'Leaves your wallet 504.00 USDC, plus a little SUI for gas',
    '4,500.00 USDC of your 30-day allowance left after',
  ]);
  assert.equal(answer.handoff.cta, 'Review in Send USDC');
  assert.match(answer.text, /I can't send it/);
  assert.deepEqual(d.calls.findRecipient, ['Manila Parts']);
});

test('amounts are re-printed from minor units, never passed through', async () => {
  const answer = await usdcHandoffFor('org_1', 'pay 1,250.50 usdc to Manila Parts', deps());
  assert.equal(answer.handoff.href, '/dashboard/send-usdc?to=sup_manila&amount=1250.5&from=zeke');
});

test('an allowance it cannot read is left out, not guessed', async () => {
  const answer = await usdcHandoffFor('org_1', 'send 10 USDC to Manila Parts', deps({ remaining: null }));
  assert.ok(answer.handoff);
  assert.equal(answer.handoff.lines.some((l) => l.includes('allowance')), false);
});

// ─── Refused, in words ──────────────────────────────────────────────────────

test('nothing is prepared for a recipient that is not a saved, payable wallet', async () => {
  const notFound = await usdcHandoffFor('org_1', 'send 5 USDC to Nobody Ltd', deps({ lookup: { status: 'NOT_FOUND', message: 'x', savedCount: 3 } }));
  assert.equal(notFound.handoff, null);
  assert.match(notFound.text, /No saved wallet recipient matches "Nobody Ltd"/);

  const ambiguous = await usdcHandoffFor('org_1', 'send 5 USDC to Manila', deps({
    lookup: { status: 'AMBIGUOUS', message: '2 saved beneficiaries match "Manila".', candidates: [WALLET_MATCH, { ...WALLET_MATCH, id: 'b', name: 'Manila Steel' }] },
  }));
  assert.equal(ambiguous.handoff, null);
  assert.match(ambiguous.text, /Manila Parts Supply, Manila Steel/);

  const bank = await usdcHandoffFor('org_1', 'send 5 USDC to Manila Parts', deps({ lookup: { status: 'FOUND', match: { ...WALLET_MATCH, payoutMethod: 'BANK', wallet: undefined } } }));
  assert.equal(bank.handoff, null);
  assert.match(bank.text, /saved as a bank recipient/);

  const blocked = await usdcHandoffFor('org_1', 'send 5 USDC to Manila Parts', deps({
    lookup: { status: 'FOUND', match: { ...WALLET_MATCH, payable: false, blockedBecause: 'its wallet has not been screened.' } },
  }));
  assert.equal(blocked.handoff, null);
  assert.match(blocked.text, /has not been screened/);
});

test('amounts the lane would refuse are refused here too', async () => {
  const tiny = await usdcHandoffFor('org_1', 'send 0.5 USDC to Manila Parts', deps());
  assert.equal(tiny.handoff, null);
  assert.match(tiny.text, /smallest wallet transfer is 1\.00 USDC/);

  const precise = await usdcHandoffFor('org_1', 'send 1.1234567 USDC to Manila Parts', deps());
  assert.equal(precise.handoff, null);

  const over = await usdcHandoffFor('org_1', 'send 500 USDC to Manila Parts', deps({ remaining: 100_000_000n }));
  assert.equal(over.handoff, null);
  assert.match(over.text, /100\.00 USDC left in your 30-day allowance/);

  const perTransfer = await usdcHandoffFor('org_1', 'send 25,000 USDC to Manila Parts', deps({ state: 'ACTIVE', remaining: 500_000_000_000n }));
  assert.equal(perTransfer.handoff, null);
  assert.match(perTransfer.text, /20,000\.00 USDC per transfer/);
});

test('a closed lane or a missing fee address prepares nothing', async () => {
  const suspended = await usdcHandoffFor('org_1', 'send 5 USDC to Manila Parts', deps({ state: 'SUSPENDED' }));
  assert.equal(suspended.handoff, null);
  const noFee = await usdcHandoffFor('org_1', 'send 5 USDC to Manila Parts', deps({ fee: false }));
  assert.equal(noFee.handoff, null);
  assert.match(noFee.text, /fee address is not configured/);
});

test('text around a name never reaches the link', async () => {
  const d = deps();
  const answer = await usdcHandoffFor('org_1', 'send 5 USDC to Manila Parts https://evil.example/?x=1&to=0xattacker', d);
  // The lookup gets the whole name; only a saved record's id could come back.
  assert.equal(d.calls.findRecipient[0], 'Manila Parts https://evil.example/?x=1&to=0xattacker');
  assert.match(answer.handoff.href, /^\/dashboard\/send-usdc\?to=sup_manila&amount=5&from=zeke$/);
});

// ─── Where it sits, and what it never touches ───────────────────────────────

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('the handoff never quotes, reserves, submits or signs', async () => {
  const handoff = code(await readFile(new URL('../lib/agent/usdc-handoff.ts', import.meta.url), 'utf8'));
  for (const forbidden of ['reserveOutflow', 'quoteWalletTransfer', 'submitWalletTransfer', 'signWith', 'executeTransfer', 'proposeForApproval', 'approveByClick']) {
    assert.doesNotMatch(handoff, new RegExp(forbidden), forbidden);
  }
});

test('Zeke answers it after the lane refusal and before the model', async () => {
  const oxwal = code(await readFile(new URL('../lib/agent/oxwal.ts', import.meta.url), 'utf8'));
  const refusal = oxwal.indexOf('await laneRefusalFor(');
  const handoff = oxwal.indexOf('await usdcHandoffFor(');
  const scripted = oxwal.indexOf('matchDemoScript(request.message');
  const model = oxwal.indexOf('yield* runClaudeToolLoop(');
  assert.ok(refusal > 0 && handoff > refusal && scripted > handoff && model > scripted);
  assert.match(oxwal, /yield \{ type: 'handoff', handoff: handoff\.handoff \}/);
});

test('the card links only into Send USDC, and Send USDC fills in without quoting', async () => {
  const thread = code(await readFile(new URL('../components/oxwal/ThreadView.tsx', import.meta.url), 'utf8'));
  assert.match(thread, /item\.handoff\.href\.startsWith\('\/dashboard\/send-usdc\?'\)/);
  const desk = code(await readFile(new URL('../components/stablecoin/SendUsdcDesk.tsx', import.meta.url), 'utf8'));
  const prefill = desk.slice(desk.indexOf("const to = params.get('to')"), desk.indexOf("setPrefilled(params.get('from') === 'zeke')"));
  assert.match(prefill, /wallets\.some\(\(r\) => r\.id === to\)/, 'only a recipient this workspace saved');
  assert.doesNotMatch(prefill, /getQuote\(|fetch\(/, 'filling in is not quoting');
});

// ─── Phase 12: more ways to ask, and the model's own way in ─────────────────

test('it also reads "in USDC", USDC before the amount, and polite framing', () => {
  assert.deepEqual(parseUsdcSendIntent('pay Manila Parts 500 in USDC'), { amount: '500', name: 'Manila Parts' });
  assert.deepEqual(parseUsdcSendIntent('send 500 in usdc to Manila Parts'), { amount: '500', name: 'Manila Parts' });
  assert.deepEqual(parseUsdcSendIntent('send USDC 500 to Manila Parts'), { amount: '500', name: 'Manila Parts' });
  assert.deepEqual(parseUsdcSendIntent('Can you send 75 USDC to Acme?'), { amount: '75', name: 'Acme' });
  assert.equal(parseUsdcSendIntent('pay Manila Parts 500 in pesos'), null, 'a currency that is not USDC is not this');
});

test('the preparation core takes a name and an amount as a person writes it', async () => {
  const answer = await prepareUsdcHandoff('org_1', { name: 'Manila Parts', amount: '$1,250.50' }, deps());
  assert.equal(answer.handoff.href, '/dashboard/send-usdc?to=sup_manila&amount=1250.5&from=zeke');
  const bad = await prepareUsdcHandoff('org_1', { name: 'Manila Parts', amount: 'five hundred' }, deps());
  assert.equal(bad.handoff, null);
  assert.match(bad.text, /I can't prepare that/);
});

test('Zeke has prepareUsdcTransfer as a READ tool, labelled, and it goes through the same checks', async () => {
  const { OXWAL_TOOL_REGISTRY, READ_TOOL_NAMES, executeOxwalTool } = await import('../lib/agent/oxwal.ts');
  assert.ok(READ_TOOL_NAMES.includes('prepareUsdcTransfer'));
  const tool = OXWAL_TOOL_REGISTRY.find((t) => t.name === 'prepareUsdcTransfer');
  assert.equal(tool.category, 'READ');
  assert.deepEqual(tool.input_schema.required, ['orgId', 'recipientName', 'amountUsdc']);

  // No fee address in the test environment: the lane is closed, so it refuses in words.
  const saved = process.env.SPLASH_FEE_ADDRESS_MAINNET;
  delete process.env.SPLASH_FEE_ADDRESS_MAINNET;
  try {
    const result = await executeOxwalTool('prepareUsdcTransfer', { orgId: 'org_test', recipientName: 'Manila Parts', amountUsdc: '500' });
    assert.equal(result.status, 'LIVE', 'read live, inside a truth envelope');
    assert.equal(result.data.prepared, false);
    assert.equal(result.data.handoff, null);
    assert.match(result.data.message, /fee address is not configured/);
  } finally {
    if (saved !== undefined) process.env.SPLASH_FEE_ADDRESS_MAINNET = saved;
  }
});

test('the model path turns a prepared transfer into the same card, and every tool has a label', async () => {
  const oxwal = code(await readFile(new URL('../lib/agent/oxwal.ts', import.meta.url), 'utf8'));
  const exec = oxwal.indexOf('const result = await executeOxwalTool(name, bindToolInputToOrg(toolUse.input, request.orgId));');
  const card = oxwal.indexOf("if (handoff) yield { type: 'handoff', handoff };", exec);
  assert.ok(exec > 0 && card > exec, 'the Claude loop yields the handoff after running the tool');
  assert.match(oxwal, /const handoff = name === 'prepareUsdcTransfer' \? usdcHandoffIn\(payload\) : null;/, 'only this tool makes a card');
  assert.match(oxwal, /handoff\.href\.startsWith\('\/dashboard\/send-usdc\?'\)/, 'only a Send USDC link becomes a card');

  const { OXWAL_TOOL_REGISTRY } = await import('../lib/agent/oxwal.ts');
  const hook = await readFile(new URL('../lib/oxwal/use-oxwal-thread.ts', import.meta.url), 'utf8');
  const labels = hook.slice(hook.indexOf('const ACTIVITY_LABELS'), hook.indexOf('};', hook.indexOf('const ACTIVITY_LABELS')));
  const unlabelled = OXWAL_TOOL_REGISTRY.map((t) => t.name).filter((name) => !new RegExp(`\\b${name}:`).test(labels));
  assert.deepEqual(unlabelled, [], 'a tool without a label shows the operator only "Working"');
});
