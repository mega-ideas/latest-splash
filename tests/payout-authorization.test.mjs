import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeBase32,
  hotp,
  matchTotpStep,
  resetConsumedStepsForTesting,
  verifyPayoutTotp,
  TOTP_STEP_SECONDS,
} from '../lib/auth/totp.ts';
import { checkAuthorizationLimits, spentTodayUsd } from '../lib/policy/authorization-limits.ts';

/**
 * The payout second factor and the operating ceilings.
 *
 * Before this, `/api/transfers/authorize` and the since-removed `/api/batches/authorize` accepted
 * any six digits (`/^\d{6}$/`) as the "authorization code", and the configured
 * per-transfer / daily limits were read by nothing. Both controls existed in
 * the UI and in the settings file, and neither existed in the code path that
 * moves money.
 */

// RFC 6238 Appendix B test vector secret: ASCII "12345678901234567890".
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('TOTP: base32 decoding matches the RFC test secret', () => {
  const decoded = decodeBase32(RFC_SECRET);
  assert.equal(decoded?.toString('ascii'), '12345678901234567890');
  assert.equal(decodeBase32('not base32!'), null);
  assert.equal(decodeBase32(''), null);
});

test('TOTP: HOTP matches the RFC 4226 published vectors', () => {
  const secret = decodeBase32(RFC_SECRET);
  // RFC 4226 Appendix D, counters 0-9.
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => {
    assert.equal(hotp(secret, counter), code, `counter ${counter}`);
  });
});

test('TOTP: a wrong code never matches, at any drift', () => {
  const secret = decodeBase32(RFC_SECRET);
  const now = 1_700_000_000_000;
  assert.equal(matchTotpStep(secret, '000000', now), null);
  assert.equal(matchTotpStep(secret, '999999', now), null);
  // The old check accepted every one of these.
  for (const shape of ['123456', '111111', '654321']) {
    const step = matchTotpStep(secret, shape, now);
    const currentStep = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
    if (step !== null) {
      assert.equal(hotp(secret, step), shape, 'a match must be a real HOTP value for that step');
      assert.ok(Math.abs(step - currentStep) <= 1);
    }
  }
});

test('TOTP: the current code matches and neighbouring steps are accepted for skew', () => {
  const secret = decodeBase32(RFC_SECRET);
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  assert.equal(matchTotpStep(secret, hotp(secret, step), now), step);
  assert.equal(matchTotpStep(secret, hotp(secret, step - 1), now), step - 1);
  assert.equal(matchTotpStep(secret, hotp(secret, step + 1), now), step + 1);
  // Two steps out is outside the window.
  assert.equal(matchTotpStep(secret, hotp(secret, step + 2), now), null);
});

test('payout: a valid code authorizes exactly once (replay is refused)', () => {
  resetConsumedStepsForTesting();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  const code = hotp(decodeBase32(RFC_SECRET), step);
  const input = {
    code,
    accountId: 'acct-a',
    requireTotp: true,
    nowMs: now,
    env: { SPLASH_TOTP_SECRET: RFC_SECRET },
  };

  const first = verifyPayoutTotp(input);
  assert.equal(first.ok, true);
  assert.equal(first.mode, 'verified');

  // Without this, one captured code authorizes every payout in its ~90s window
  // — which is exactly the batch double-pay scenario.
  const second = verifyPayoutTotp(input);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'replayed');
});

test('payout: replay protection is per account, not global', () => {
  resetConsumedStepsForTesting();
  const now = 1_700_000_000_000;
  const code = hotp(decodeBase32(RFC_SECRET), Math.floor(now / 1000 / TOTP_STEP_SECONDS));
  const env = { SPLASH_TOTP_SECRET: RFC_SECRET };
  assert.equal(verifyPayoutTotp({ code, accountId: 'acct-a', requireTotp: true, nowMs: now, env }).ok, true);
  assert.equal(verifyPayoutTotp({ code, accountId: 'acct-b', requireTotp: true, nowMs: now, env }).ok, true);
});

test('payout: with no secret enrolled the request FAILS CLOSED', () => {
  resetConsumedStepsForTesting();
  const verdict = verifyPayoutTotp({ code: '123456', accountId: 'acct-a', requireTotp: true, env: {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'not_enrolled');
  // The whole point: an unenrolled deployment must not silently accept the
  // format check, which is what shipped before.
  assert.match(verdict.message, /SPLASH_TOTP_SECRET/);
});

test('payout: the requireTotp toggle is load-bearing', () => {
  resetConsumedStepsForTesting();
  const verdict = verifyPayoutTotp({ code: '', accountId: 'acct-a', requireTotp: false, env: {} });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.mode, 'disabled');
});

test('payout: a per-account secret overrides the workspace secret', () => {
  resetConsumedStepsForTesting();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  const other = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJA';
  const env = { SPLASH_TOTP_SECRET: RFC_SECRET, SPLASH_TOTP_SECRET_ACCT_A: other };

  const workspaceCode = hotp(decodeBase32(RFC_SECRET), step);
  const accountCode = hotp(decodeBase32(other), step);
  assert.notEqual(workspaceCode, accountCode);

  assert.equal(verifyPayoutTotp({ code: accountCode, accountId: 'acct-a', requireTotp: true, nowMs: now, env }).ok, true);
  resetConsumedStepsForTesting();
  assert.equal(verifyPayoutTotp({ code: workspaceCode, accountId: 'acct-a', requireTotp: true, nowMs: now, env }).ok, false);
});

// ── Operating ceilings ──────────────────────────────────────────────────────

const SETTINGS = {
  perTransferLimitUsd: 1_000,
  dailyLimitUsd: 5_000,
  approvalThresholdUsd: 900,
  autoAllocateTreasuryPct: 1,
  requireTotp: true,
  requireDualApproval: false,
  blockHighRiskCorridors: true,
  notifyOnSettlement: true,
  updatedAt: new Date(0).toISOString(),
};

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

test('limits: a transfer above the per-transfer ceiling is refused', () => {
  const verdict = checkAuthorizationLimits({ amountUsd: 40_000, settings: SETTINGS, ledger: [], nowMs: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'above_per_transfer_limit');
});

test('limits: the daily ceiling counts only DEBITs from today', () => {
  const ledger = [
    { direction: 'DEBIT', amountUsdcMicro: 4_500_000_000, createdAt: new Date(NOW - 60_000).toISOString() },
    // Yesterday — must not consume today's budget.
    { direction: 'DEBIT', amountUsdcMicro: 9_000_000_000, createdAt: new Date(NOW - 26 * 3_600_000).toISOString() },
    // A deposit is not a payout.
    { direction: 'CREDIT', amountUsdcMicro: 50_000_000_000, createdAt: new Date(NOW - 60_000).toISOString() },
  ];
  assert.equal(spentTodayUsd(ledger, NOW), 4_500);

  const verdict = checkAuthorizationLimits({ amountUsd: 900, settings: SETTINGS, ledger, nowMs: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'above_daily_limit');

  const under = checkAuthorizationLimits({ amountUsd: 400, settings: SETTINGS, ledger, nowMs: NOW });
  assert.equal(under.ok, true);
});

test('limits: dual approval is required only above the threshold, and only when enabled', () => {
  const dual = { ...SETTINGS, requireDualApproval: true };
  const below = checkAuthorizationLimits({ amountUsd: 899, settings: dual, ledger: [], nowMs: NOW });
  assert.equal(below.ok && below.requiresSecondApproval, false);

  const at = checkAuthorizationLimits({ amountUsd: 900, settings: dual, ledger: [], nowMs: NOW });
  assert.equal(at.ok && at.requiresSecondApproval, true);

  const off = checkAuthorizationLimits({ amountUsd: 1_000, settings: SETTINGS, ledger: [], nowMs: NOW });
  assert.equal(off.ok && off.requiresSecondApproval, false);
});
