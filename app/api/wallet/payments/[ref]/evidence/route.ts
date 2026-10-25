import { NextResponse } from 'next/server';

import { EvidenceLeak, evidenceJson, evidencePdf, evidenceSha256 } from '@/lib/compliance/controls-evidence';
import { complianceResponse, evidenceDepsFor } from '@/lib/server/compliance-deps';
import { controlsEvidenceFor } from '@/lib/server/controls-evidence';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { NO_STORE,requirePayoutReader, walletRoute } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * One payment's controls evidence (v2 §4.6): `?format=json` (the default) or
 * `?format=pdf`, the same content. The payment is named by its intent id,
 * its payout id or its signing request id, and only this business's own is
 * found: another business's reads as absent (404). Owners and staff; a
 * viewer does not see payments. No secret, signature, sealed value or
 * account number is in either copy: a document that would hold one is
 * refused (422) rather than exported.
 */
export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.complianceReadUser, key: gate.route.authority.userId });
  if (limited) return limited;
  const format = new URL(request.url).searchParams.get('format') ?? 'json';
  if (format !== 'json' && format !== 'pdf') return NextResponse.json({ error: 'format is json or pdf' }, { status: 400, headers: NO_STORE });
  // Next has decoded the parameter already; decoding again would turn "%25" into "%" and can throw.
  const { ref } = await params;
  try {
    const result = await controlsEvidenceFor(evidenceDepsFor(gate.route), ref, gate.route.authority.userId);
    if (!result.ok) return complianceResponse(result);
    const name = `splash-controls-evidence-${result.evidence.payment.ref}`;
    const headers = { ...NO_STORE, 'X-Content-SHA256': evidenceSha256(result.evidence) };
    if (format === 'pdf') {
      return new Response(Buffer.from(evidencePdf(result.evidence)), {
        headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}.pdf"` },
      });
    }
    return new Response(evidenceJson(result.evidence), {
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.json"` },
    });
  } catch (error) {
    if (error instanceof EvidenceLeak) {
      console.error('[evidence] a document was refused: it held a field it must not');
      return NextResponse.json({ error: 'The evidence for this payment could not be produced: it holds a field that is never exported. Ask Splash support.', code: 'evidence_refused' }, { status: 422, headers: NO_STORE });
    }
    throw error;
  }
}
