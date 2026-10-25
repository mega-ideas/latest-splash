import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { workspaceForEmail } from '../lib/auth/signup-org.ts';

/** Comments explaining what a defect USED to be are documentation, not the
 *  defect. Both assertions below want the code. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

/**
 * Signing up with zkLogin lands you in your own workspace, awaiting KYB.
 *
 * Two defects sat behind this, and the second is the one that mattered:
 *
 *   Every zkLogin identity was written with `orgId: DEFAULT_ORG_ID` — the
 *   literal 'demo-business'. Every person who signed in with Google was filed
 *   under one shared organisation.
 *
 *   The KYB gate FAILED OPEN. It caught the error a membership-less session
 *   raises, logged "treating as unblocked", and returned ACTIVE — for exactly
 *   the account it exists to stop.
 */

test('colleagues share a workspace; strangers do not', () => {
  // The email domain is the only signal at sign-in that says "these two work
  // together".
  assert.equal(workspaceForEmail('nadia@acme.com').orgId, workspaceForEmail('ben@acme.com').orgId);
  assert.equal(workspaceForEmail('nadia@acme.com').shared, true);

  // Two gmail users are not colleagues. Treating them as such would put
  // strangers in one workspace — the exact defect being fixed.
  const a = workspaceForEmail('nadia@gmail.com');
  const b = workspaceForEmail('someone.else@gmail.com');
  assert.notEqual(a.orgId, b.orgId);
  assert.equal(a.shared, false);

  for (const domain of ['outlook.com', 'yahoo.com', 'icloud.com', 'proton.me', 'qq.com']) {
    assert.equal(workspaceForEmail(`x@${domain}`).shared, false, `${domain} is not a company`);
  }
});

test('nobody lands in the demo workspace', () => {
  for (const email of ['nadia@acme.com', 'x@gmail.com', 'someone@splash.finance']) {
    assert.notEqual(workspaceForEmail(email).orgId, 'demo-business');
  }
});

test('the workspace is named after what is known, not what is guessed', () => {
  // A legal name arrives with KYB. Inventing one here would put a fiction on a
  // compliance record.
  assert.equal(workspaceForEmail('nadia@acme-trading.com.my').displayName, 'acme-trading.com.my');
  assert.match(workspaceForEmail('nadia@gmail.com').displayName, /nadia/);
});

test('a new workspace is created inert', async () => {
  const source = await readFile(new URL('../lib/auth/signup-org.ts', import.meta.url), 'utf8');
  // REGISTERED is the state that can do nothing: canMoveMoney is true only at
  // ACTIVE, and reaching ACTIVE needs the provider's verdict AND a human.
  assert.match(source, /kybLifecycle: 'REGISTERED'/);
  // And no membership is granted — authority comes from a membership row, and
  // this hands none out.
  assert.doesNotMatch(source, /grantMembership|memberships/);
});

test('zkLogin files the identity under that workspace, not the demo org', async () => {
  const route = await readFile(
    new URL('../app/api/auth/zklogin/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /ensureWorkspaceForEmail\(email\)/);
  assert.match(route, /orgId: workspace\.orgId/);
  assert.match(route, /orgId: sessionWorkspace\.orgId/);
  // The pin is gone entirely.
  assert.doesNotMatch(code(route), /DEFAULT_ORG_ID/);
});

test('sign-in lands on Home, where Account setup leads to verification', async () => {
  const callback = await readFile(
    new URL('../app/login/zklogin/callback/page.tsx', import.meta.url),
    'utf8',
  );
  // v2 D14: Home is the first screen after login, for every sign-in. It used
  // to send zkLogin straight to /settings/kyb, because a banner alone is not
  // an onboarding step. The step is now in the nav: Account setup stays on
  // the rail, with its progress, until setup is complete (brief 5.1), and the
  // read-only banner links to verification.
  assert.match(callback, /router\.replace\('\/dashboard'\)/);
  assert.doesNotMatch(callback, /router\.replace\('\/settings\/kyb/);
  const shell = await readFile(new URL('../components/dashboard/DashboardShell.tsx', import.meta.url), 'utf8');
  assert.match(shell, /view\.setup \?/, 'the setup step is on the rail until it is done');
  assert.match(shell, /href="\/settings\/kyb"/, 'the read-only banner links to verification');
});

test('the KYB gate fails closed', async () => {
  const gate = await readFile(new URL('../lib/server/kyb-gate.ts', import.meta.url), 'utf8');

  // It used to catch, log "treating as unblocked", and return ACTIVE. The throw
  // it was catching is what a session with no membership raises — which is what
  // a brand-new sign-up IS.
  assert.doesNotMatch(code(gate), /treating as unblocked/);
  assert.match(gate, /state could not be read; blocking/);
  assert.match(gate, /blocked: true/);
  // A compliance gate that cannot determine state has not determined that
  // everything is fine.
  assert.doesNotMatch(gate, /return \{ state: 'ACTIVE', blocked: false, reason: '' \};\s*\n\s*\}\s*\n\}/);
});

test('a membership-less session gets an answer, not a 500', async () => {
  const gate = await readFile(new URL('../lib/server/kyb-gate.ts', import.meta.url), 'utf8');
  // `resolveAuthorityForSession` throws for the most ordinary state a new
  // account is in, and unguarded that surfaced as an unhandled error which
  // tells the caller nothing about what to do next.
  assert.match(gate, /error instanceof UnauthorizedError/);
  assert.match(gate, /code: 'kyb_required'/);
  assert.match(gate, /status: 403/);
});
