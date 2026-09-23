import { pythAdapter } from '@/lib/server/pyth';
import { moneyJson } from '@/lib/server/json';

/**
 * Peg health, from DeepBook (primary) and Pyth (secondary).
 *
 * `moneyJson`, not `NextResponse.json`: the payload embeds two `Rate` values
 * whose `scaled` field is a bigint, and the plain responder throws on those.
 * This route returned a 500 for exactly that reason — see lib/server/json.ts.
 */
export async function GET() {
  const pegStatus = await pythAdapter.getPegStatus();

  return moneyJson(pegStatus, { headers: { 'Cache-Control': 'no-store' } });
}
