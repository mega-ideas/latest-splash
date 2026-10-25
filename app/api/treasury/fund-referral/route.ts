import { readJsonBody } from '@/lib/server/http';
import { liveFundDeps } from '@/lib/server/treasury-deps';
import { answer, treasuryCaller, treasuryDb } from '@/lib/server/treasury-route';
import { handleFundReferralRead, handleFundReferralWrite } from '@/lib/server/treasury-wallet';

export const dynamic = 'force-dynamic';

/**
 * The fund-manager referral (v2 D9, brief 5.7). Behind FEATURE_FUND_REFERRAL,
 * off until legal signs off its wording: off, both methods answer 404 and the
 * page shows no section.
 *
 * GET   this business's assessment, its referral link if eligible, and its
 *       holding (read-only) once an account is linked.
 * POST  owners only:
 *         { action: 'assess', answers }   the eligibility questions
 *         { action: 'opened' }            the referral link was opened
 *         { action: 'link', reference }   the account the fund manager gave
 */
export async function GET(request: Request) {
  const gate = await treasuryCaller(request);
  if (gate.response) return gate.response;
  const deps = liveFundDeps();
  if (!deps.enabled) return answer(await handleFundReferralRead(null, gate.caller, deps));
  const store = await treasuryDb();
  if (store.response) return store.response;
  return answer(await handleFundReferralRead(store.db, gate.caller, deps));
}

export async function POST(request: Request) {
  const gate = await treasuryCaller(request);
  if (gate.response) return gate.response;
  const deps = liveFundDeps();
  if (!deps.enabled) return answer(await handleFundReferralWrite(null, gate.caller, {}, deps));
  const store = await treasuryDb();
  if (store.response) return store.response;
  return answer(await handleFundReferralWrite(store.db, gate.caller, await readJsonBody(request), deps));
}
