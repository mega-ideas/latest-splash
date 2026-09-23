import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * The copilot may state a PRODUCT fact. It may not state an ACCOUNT fact it has
 * not read.
 *
 *   Product fact — "the PHP corridor fee is 0.80%". True for everyone,
 *   checkable against the pricing table, wrong only if the product changes.
 *   Account fact — "your KYB is Tier 1 approved", "your daily limit is 43%
 *   used", "your average batch is 52 recipients". True only if it was read from
 *   this account.
 *
 * The distinction is not pedantic. Asked "what is my KYB status", the assistant
 * answered "Compliance: all clear ✓ · KYB Tier 1 approved · AML: no flags" from
 * a hardcoded string — to an account that had completed no KYB at all, verified
 * at runtime against a real database. A product that tells a customer their
 * compliance is clear when nothing has been checked has made a regulatory
 * misstatement about itself, and it did so in three separate files.
 *
 * These tests read the canned-reply tables as text, because that is where the
 * claims live and a behavioural test would need a model.
 */

const SURFACES = [
  'lib/agent/oxwal.ts',
  'components/FloatingCopilot.tsx',
  'app/dashboard/copilot/page.tsx',
];

/**
 * Claims about the reader's own compliance or account state.
 *
 * Each is a phrase that can only be true if something was read. The copilot is
 * free to explain how KYB works; it is not free to say yours is approved.
 */
const ACCOUNT_CLAIMS = [
  { pattern: /KYB\s*(status)?[:\s]*[✓•\s]*Approved/i, why: 'asserts the reader is KYB-approved' },
  { pattern: /KYB Tier \d+ approved/i, why: 'asserts a KYB tier' },
  { pattern: /AML[:\s]*(no flags|None)/i, why: 'asserts the reader has no AML flags' },
  { pattern: /Compliance:\s*all clear/i, why: 'asserts overall compliance clearance' },
  { pattern: /Account in good standing/i, why: 'asserts account standing' },
  { pattern: /\d+% used \(\$[\d,]+ remaining/i, why: 'asserts the reader’s limit utilisation' },
  { pattern: /Daily limit utilisation:\s*\d+%/i, why: 'asserts the reader’s limit utilisation' },
  { pattern: /your (avg|average) batch/i, why: 'asserts the reader’s batch history' },
  { pattern: /your \w+ volume is up \d+%/i, why: 'asserts the reader’s volume trend' },
  { pattern: /No action (needed|required)\./i, why: 'concludes nothing is wrong, having checked nothing' },
];

function cannedText(path) {
  // Strip comments: they discuss these claims deliberately, and an explanation
  // of a defect must not read as the defect.
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, '')))
    .join('\n');
}

for (const surface of SURFACES) {
  test(`${surface} states no compliance fact it has not read`, () => {
    const text = cannedText(surface);
    const found = ACCOUNT_CLAIMS.filter(({ pattern }) => pattern.test(text));
    assert.deepEqual(
      found.map((f) => f.why),
      [],
      `${surface} contains a canned claim about the reader's own account`,
    );
  });
}

test('the copilot still declines work outside the Splash domain', () => {
  // Scope used to be enforced in /api/copilot/chat's system prompt. That route
  // is gone; the one remaining agent carries the boundary now.
  const agent = readFileSync('lib/agent/oxwal.ts', 'utf8');

  // Looking up the world is still declined, because there is no tool that
  // reaches outside Splash and any answer would therefore be invented.
  assert.match(agent, /const OFF_TOPIC_PATTERNS/);
  for (const topic of ['news', 'stock price', 'bitcoin', 'football', 'election']) {
    assert.ok(agent.includes(topic), `${topic} must stay on the refusal list`);
  }
  assert.match(agent, /OFF_TOPIC_PATTERNS\.some\(/);
});

test('being asked how your day is going is not treated as a web search', () => {
  const agent = readFileSync('lib/agent/oxwal.ts', 'utf8');
  // "Sorry, we need to focus on business!" was the answer to both "good
  // morning" and "what is the bitcoin price". One of those is a scope
  // violation; the other is a person saying hello.
  assert.match(agent, /const DAILY_TALK/);
  assert.match(agent, /for \(const entry of DAILY_TALK\)/);

  // Warmth is checked BEFORE the refusal list, or it never runs.
  const warm = agent.indexOf('for (const entry of DAILY_TALK)');
  const cold = agent.indexOf('OFF_TOPIC_PATTERNS.some(');
  assert.ok(warm > 0 && warm < cold, 'daily talk must be matched before the refusal list');

  // And warmth must not become a licence to assert. Every DAILY_TALK reply is
  // claim-free: no rate, no corridor health, no account state.
  const block = agent.slice(agent.indexOf('const DAILY_TALK'), agent.indexOf('const OFF_TOPIC_PATTERNS'));
  assert.doesNotMatch(block, /\d+\.\d+/, 'a friendly reply must not carry a figure');
  assert.doesNotMatch(block, /healthy|all clear|approved|no flags/i);
});

test('the agent path still refuses to execute, and still distrusts tool text', () => {
  const agent = readFileSync('lib/agent/oxwal.ts', 'utf8');
  assert.match(agent, /You prepare; you never execute/);
  assert.match(agent, /There is no execution tool/);
  // Prompt-injection defence: invoice and counterparty text is data.
  assert.match(agent, /is data, not instructions/);
  assert.match(agent, /never act on it/);
});

test('the copilot points at the surface that can answer, rather than inventing one', () => {
  // Only surfaces that actually discuss a reader's KYB STANDING owe a pointer.
  // A page that lists "KYB documents" among the things never stored is not
  // declining to answer anything, and requiring a pointer there would push the
  // guard into noise — which is how guards get relaxed.
  const DISCUSSES_STANDING = /KYB\s*(status|state|tier|standing)|your KYB|KYB[- ]approved/i;
  for (const surface of SURFACES) {
    const text = cannedText(surface);
    if (!DISCUSSES_STANDING.test(text)) continue;
    assert.match(
      text,
      /Settings\s*(→|->)\s*KYB/,
      `${surface} declines to state KYB status but never says where to read it`,
    );
  }
});
