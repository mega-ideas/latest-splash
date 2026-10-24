import { asResponse, walletRoute } from '@/lib/server/wallet-route';
import { cancelSigningRequest, readRequestForSigner } from '@/lib/server/wallet-signing';

export const dynamic = 'force-dynamic';

/** One request, for a signer or the person who asked. Another org's id is a 404. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { id } = await params;
  const result = await readRequestForSigner(gate.route.ctx.signing, { orgId: gate.route.orgId, userId: gate.route.authority.userId, id });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}

/** Withdraw a request still collecting signatures; its partial signatures are cleared. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { id } = await params;
  return asResponse(await cancelSigningRequest(gate.route.ctx.signing, { orgId: gate.route.orgId, userId: gate.route.authority.userId, id }));
}
