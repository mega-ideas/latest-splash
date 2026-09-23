import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The WhatsApp approval path had a server and no way in.
 *
 * `/api/approvals/channel` registered and verified an approver's number, and
 * `approvalChannel` / `whatsappEnabled` were persisted per org — and nothing in
 * the product called any of it. An approver could not register a number, so no
 * approval request could reach anybody, so the feature was unreachable however
 * correct the server was.
 */

const card = () =>
  readFile(new URL('../components/settings/ApprovalChannelCard.tsx', import.meta.url), 'utf8');
const page = () =>
  readFile(new URL('../app/dashboard/settings/page.tsx', import.meta.url), 'utf8');

test('the settings page carries the two dials it saves', async () => {
  const source = await page();
  // Present in the type, or a save round-trip drops them from the payload.
  assert.match(source, /approvalChannel: 'code' \| 'reply';/);
  assert.match(source, /whatsappEnabled: boolean;/);
  assert.match(source, /<ApprovalChannelCard/);
});

test('the choice between modes states what each one actually authenticates', async () => {
  const source = await card();

  // This is the sentence that makes the decision an informed one: `code`
  // requires the handset AND a signed-in approver; `reply` requires only the
  // handset. An admin choosing between them is making a security decision, so
  // the consequence belongs beside the option, not in documentation.
  assert.match(source, /a stolen handset on its own releases nothing/i);
  assert.match(source, /Whoever is holding the phone can release the payment/i);

  // And the weaker option is marked as weaker rather than merely "faster".
  assert.match(source, /Weaker/);
  assert.match(source, /Default/);
});

test('an unverified number is described as unusable, not merely unconfirmed', async () => {
  const source = await card();
  assert.match(source, /An unconfirmed number is never used/);
  // The failure mode is silence, which is the part an operator would not
  // otherwise predict: they are not told they were skipped.
  assert.match(source, /you would never know you had not been asked/);
});

test('the card drives the real endpoints, in the right order', async () => {
  const source = await card();
  // POST registers and sends; PUT proves possession. Both against the same
  // route, so a surface cannot invent its own verification.
  assert.match(source, /fetch\('\/api\/approvals\/channel', \{\s*\n?\s*method: 'POST'/);
  assert.match(source, /fetch\('\/api\/approvals\/channel', \{\s*\n?\s*method: 'PUT'/);
  // The confirm field only appears once a code has actually been sent.
  assert.match(source, /\{awaitingCode && \(/);
  // Nothing here decides whether a number is verified — the server does.
  assert.doesNotMatch(
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, ''),
    /verified: true,\s*\}\);\s*\n\s*setNotice\('Confirmed/,
  );
});

test('a role that cannot approve is not shown a broken form', async () => {
  const source = await card();
  // GET answers 403 for a viewer or maker. That is not an error to surface as
  // a failure — they simply have no approval channel, because they do not
  // approve payments.
  assert.match(source, /setChannel\(\{ whatsapp: null, verified: false \}\)/);
});
