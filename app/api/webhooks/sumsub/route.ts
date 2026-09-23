import { createHmac, timingSafeEqual } from 'node:crypto';

import { setOrgKybState } from '@/lib/compliance/org-kyb';

/**
 * Sumsub's verdict on a business.
 *
 * ─── The signature is the only defence, again ───────────────────────────────
 *
 * Same shape as the WhatsApp webhook and worth restating, because the
 * consequence here is different and larger. This endpoint is public, carries no
 * session, and moves an organisation from KYB_SUBMITTED to
 * KYB_PROVIDER_APPROVED — the state that says an independent provider has
 * checked who these people are.
 *
 * Unverified, anyone who learns the URL could assert that verdict for any org.
 * Not "release a payment" — worse: launder an unverified business into the part
 * of the lifecycle a human then signs off, where the human's whole basis for
 * signing is that the provider already checked.
 *
 * So the payload is verified before it is parsed for meaning, and an
 * unverifiable request is refused. Unconfigured verifies as false.
 *
 * ─── A provider cannot make a business live ─────────────────────────────────
 *
 * `KybActor` is `PROVIDER` here and the state machine only permits PROVIDER to
 * reach KYB_PROVIDER_APPROVED or REJECTED. It cannot reach ACTIVE, which is the
 * only state that can move money. That separation is deliberate and this route
 * does not get to opt out of it: a webhook, however well authenticated, is a
 * message from a vendor, and a vendor does not decide that a Splash customer
 * may send money.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sumsub signs the raw body with the webhook secret. The algorithm is named in
 * `x-payload-digest-alg`, defaulting to SHA-1 for older integrations.
 */
function verify(raw: string, digest: string | null, alg: string | null): boolean {
  const secret = (process.env.SUMSUB_WEBHOOK_SECRET ?? '').trim();
  if (!secret || !digest) return false;

  const algorithm =
    alg === 'HMAC_SHA512_HEX' ? 'sha512' : alg === 'HMAC_SHA256_HEX' ? 'sha256' : 'sha1';
  const expected = createHmac(algorithm, secret).update(raw, 'utf8').digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(digest);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Which of our orgs this applies to.
 *
 * `externalUserId` is what we set when creating the applicant, and it is the
 * only field here we control. Everything else in the payload is the vendor's
 * and is treated as data — a review answer is not permitted to name the org it
 * applies to by any other route, or one org's rejection could be pointed at
 * another org's record.
 */
function orgFromPayload(payload: Record<string, unknown>): string | null {
  const external = payload.externalUserId;
  if (typeof external !== 'string' || external.length === 0) return null;
  // We create applicants as `org:<orgId>`; anything else is not ours.
  return external.startsWith('org:') ? external.slice(4) : null;
}

export async function POST(request: Request) {
  const raw = await request.text();

  if (
    !verify(
      raw,
      request.headers.get('x-payload-digest'),
      request.headers.get('x-payload-digest-alg'),
    )
  ) {
    console.warn('[sumsub] refused an unverified webhook');
    return new Response('forbidden', { status: 403 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const orgId = orgFromPayload(payload);
  if (!orgId) {
    // Verified, but not about anything of ours. 200 so Sumsub stops retrying.
    console.info('[sumsub] verified webhook for an unknown subject; ignoring');
    return Response.json({ ok: true, applied: false });
  }

  const type = String(payload.type ?? '');
  const review = (payload.reviewResult ?? {}) as { reviewAnswer?: string };
  const answer = String(review.reviewAnswer ?? '');

  // Only a completed review is a verdict. `applicantPending`,
  // `applicantOnHold` and the rest are progress, and treating progress as a
  // verdict is how an unfinished check becomes an approval.
  if (type !== 'applicantReviewed') {
    return Response.json({ ok: true, applied: false, reason: `type ${type} is not a verdict` });
  }

  const next =
    answer === 'GREEN' ? 'KYB_PROVIDER_APPROVED' : answer === 'RED' ? 'REJECTED' : null;
  if (!next) {
    return Response.json({ ok: true, applied: false, reason: `answer ${answer} is not decisive` });
  }

  try {
    // PROVIDER. The machine permits this actor only KYB_PROVIDER_APPROVED and
    // REJECTED — never ACTIVE, which is the state that can move money and needs
    // a human whose basis for signing is that the provider already checked.
    const moved = await setOrgKybState(orgId, next, 'PROVIDER');
    console.info('[sumsub] %s: %s -> %s', orgId, moved.from, moved.to);
    return Response.json({ ok: true, applied: true, from: moved.from, to: moved.to });
  } catch (error) {
    // An illegal transition is not an error to retry — a verdict arriving for
    // an org already rejected, or already live, is a duplicate delivery. 200 so
    // Sumsub stops, and a log so a person can look.
    console.warn('[sumsub] verdict could not be applied to %s', orgId, error);
    return Response.json({ ok: true, applied: false, reason: 'transition not permitted' });
  }
}
