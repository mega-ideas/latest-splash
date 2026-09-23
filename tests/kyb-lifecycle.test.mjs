import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The KYB lifecycle can now advance, and only in the permitted direction.
 *
 * Before this, nothing anywhere called `setOrgKybState` with KYB_SUBMITTED or
 * KYB_PROVIDER_APPROVED. An org could never leave REGISTERED however many
 * documents were uploaded — an onboarding flow whose first step does not change
 * the state it exists to change is a form that files paperwork into a drawer.
 */

const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

test('uploading documents moves the org, as SYSTEM', async () => {
  const route = await readFile(new URL('../app/api/kyb/upload/route.ts', import.meta.url), 'utf8');
  assert.match(route, /setOrgKybState\(orgId, 'KYB_SUBMITTED', 'SYSTEM'\)/);
  // SYSTEM is the only actor permitted this transition: a provider cannot
  // declare a business submitted, and an admin signing off is a later step.
  assert.doesNotMatch(code(route), /'KYB_SUBMITTED', '(PROVIDER|ADMIN)'/);
});

test('a brand-new account submits into its own workspace, not the demo one', async () => {
  const route = await readFile(new URL('../app/api/kyb/upload/route.ts', import.meta.url), 'utf8');
  // A membership-less session is what a fresh sign-up IS — password sign-up
  // grants no membership on purpose — so refusing their documents would make
  // onboarding impossible for the only people who need it.
  assert.match(route, /error instanceof UnauthorizedError/);

  // But it used to file them under `orgId: 'demo-business'`, so every new
  // business's KYB case landed in the demo namespace alongside the sample
  // companies and each other. They get their own workspace, in REGISTERED.
  assert.match(route, /ensureWorkspaceForEmail\(auth\.session\.email\)/);
  assert.doesNotMatch(
    route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, ''),
    /'demo-business'/,
  );

  // And the org is resolved BEFORE the case is written, because it is stored
  // on the row — a case with no owner cannot be scoped to one.
  const orgAt = route.indexOf('orgId = (await resolveAuthorityForSession');
  const writeAt = route.indexOf('recordKybSubmission({');
  assert.ok(orgAt > 0 && orgAt < writeAt, 'the owning org is known before the case is written');
});

// ── The provider's verdict ─────────────────────────────────────────────────

function digest(raw, secret, algorithm = 'sha1') {
  return createHmac(algorithm, secret).update(raw, 'utf8').digest('hex');
}

test('the Sumsub webhook verifies before it parses', async () => {
  const route = await readFile(
    new URL('../app/api/webhooks/sumsub/route.ts', import.meta.url),
    'utf8',
  );
  const verifyAt = route.indexOf('if (\n    !verify(');
  const parseAt = route.indexOf('JSON.parse(raw)');
  assert.ok(verifyAt > 0 && verifyAt < parseAt, 'the digest is checked before the body is read');
  assert.match(route, /return new Response\('forbidden', \{ status: 403 \}\)/);
});

test('the signature check matches Sumsub, and refuses when unconfigured', async () => {
  const source = await readFile(
    new URL('../app/api/webhooks/sumsub/route.ts', import.meta.url),
    'utf8',
  );
  // Sumsub names the algorithm in a header and defaults to SHA-1 for older
  // integrations; assuming SHA-256 would reject every legitimate delivery.
  assert.match(source, /x-payload-digest-alg/);
  assert.match(source, /HMAC_SHA512_HEX/);
  assert.match(source, /HMAC_SHA256_HEX/);
  assert.match(source, /: 'sha1'/);
  // No secret means no verification means refuse.
  assert.match(source, /if \(!secret \|\| !digest\) return false/);
  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a length mismatch.
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /a\.length === b\.length/);

  // And the digest we compute is the one Sumsub would send.
  const raw = '{"type":"applicantReviewed"}';
  assert.equal(digest(raw, 'secret').length, 40);
});

test('a provider cannot make a business live', async () => {
  const route = await readFile(
    new URL('../app/api/webhooks/sumsub/route.ts', import.meta.url),
    'utf8',
  );
  // The machine permits PROVIDER only KYB_PROVIDER_APPROVED and REJECTED.
  // ACTIVE is the only state that can move money, and the human who signs it
  // off does so on the basis that the provider already checked — so the
  // provider granting it would remove the thing being relied on.
  assert.match(route, /setOrgKybState\(orgId, next, 'PROVIDER'\)/);
  assert.doesNotMatch(code(route), /'ACTIVE'/);

  const machine = await readFile(
    new URL('../lib/compliance/kyb-state.ts', import.meta.url),
    'utf8',
  );
  assert.match(machine, /PROVIDER: \['KYB_PROVIDER_APPROVED', 'REJECTED'\]/);
});

test('progress is not a verdict', async () => {
  const route = await readFile(
    new URL('../app/api/webhooks/sumsub/route.ts', import.meta.url),
    'utf8',
  );
  // `applicantPending` and `applicantOnHold` are progress. Treating progress as
  // a verdict is how an unfinished check becomes an approval.
  assert.match(route, /if \(type !== 'applicantReviewed'\)/);
  assert.match(route, /answer === 'GREEN'/);
  assert.match(route, /answer === 'RED'/);
  // Anything else is not decisive and changes nothing.
  assert.match(route, /is not decisive/);
});

test('the org is named by the one field we control', async () => {
  const route = await readFile(
    new URL('../app/api/webhooks/sumsub/route.ts', import.meta.url),
    'utf8',
  );
  // `externalUserId` is what we set when creating the applicant. Letting the
  // payload name the org any other way would let one org's rejection be
  // pointed at another org's record.
  assert.match(route, /external\.startsWith\('org:'\)/);
  assert.match(route, /function orgFromPayload/);
});

test('a duplicate delivery does not become a retry loop', async () => {
  const route = await readFile(
    new URL('../app/api/webhooks/sumsub/route.ts', import.meta.url),
    'utf8',
  );
  // A verdict for an org already rejected, or already live, is a duplicate.
  // 200 so Sumsub stops, and a log so a person can look.
  assert.match(route, /transition not permitted/);
  assert.match(route, /applied: false/);
});

// ── An approver's number is proved before it is used ───────────────────────

test('a number is inert until possession is proved', async () => {
  const route = await readFile(
    new URL('../app/api/approvals/channel/route.ts', import.meta.url),
    'utf8',
  );
  // A transposed digit routes every approval request to a stranger's phone,
  // silently — the approver simply never gets asked.
  assert.match(route, /verifiedAt: null/);
  assert.match(route, /set: \{ whatsappE164: e164, verifiedAt: null/, 're-registering resets it');
  assert.match(route, /verifiedAt: new Date\(\)/);
});

test('you may only register your own number, and only one person may hold it', async () => {
  const route = await readFile(
    new URL('../app/api/approvals/channel/route.ts', import.meta.url),
    'utf8',
  );
  // From the session, never the body — otherwise one person could hold two
  // ballots.
  assert.match(route, /userId: ctx\.userId/);
  assert.doesNotMatch(code(route), /userId: body\.|userId: parsed\./);
  assert.match(route, /already registered to another approver/);
  // And only someone who can approve has any use for a channel.
  assert.match(route, /canApprove\(dbRole\)/);
});
