import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * GET /api/funding/sessions/[id] answered any signed-in customer with any
 * org's funding session, and in the demo posture its POST let them simulate a
 * deposit into it, crediting that other org's ledger. The id is a random
 * fund_<uuid>, which makes it hard to guess, not private: it travels in URLs,
 * logs and support tickets. Every other tenant-owned record here is read
 * through the caller's org (WS2), and so must this one be.
 *
 * Both handlers resolve the caller's org with requireSessionAccount and treat
 * a session of another org exactly like a missing one (404), so the answer
 * does not even confirm that the id exists.
 *
 * Red before green: on the tree before the fix neither handler resolves the
 * caller's org.
 */

const ROUTE = 'app/api/funding/sessions/[id]/route.ts';

async function code(relative) {
  const text = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function handler(source, method) {
  const start = source.indexOf(`export async function ${method}(`);
  assert.ok(start >= 0, `${ROUTE} exports ${method}`);
  const next = source.indexOf('export async function', start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

for (const method of ['GET', 'POST']) {
  test(`${method} reads the session through the caller's org`, async () => {
    const body = handler(await code(ROUTE), method);
    assert.match(body, /requireSessionAccount\(/, `${method} resolves the caller's org`);
    const read = body.indexOf('readFundingSession(');
    assert.ok(read >= 0, `${method} reads the session`);
    assert.match(body, /\.orgId\s*!==\s*\w+(\.account)?\.orgId|\w+(\.account)?\.orgId\s*!==\s*\w+\.orgId/, `${method} compares the session's org with the caller's`);
  });
}

test("another org's session is answered as not found, with the same message as a missing one", async () => {
  const source = await code(ROUTE);
  for (const method of ['GET', 'POST']) {
    const body = handler(source, method);
    const notFound = body.match(/'Funding session not found'/g) ?? [];
    assert.ok(notFound.length >= 1, `${method} has one not-found answer`);
    assert.doesNotMatch(body, /does not belong|another organization|forbidden/i, `${method} does not confirm the id exists`);
  }
});
