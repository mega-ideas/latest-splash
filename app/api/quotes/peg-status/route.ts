import { getPegStatus } from '@/lib/server/peg';
import { moneyJson } from '@/lib/server/json';

/**
 * Peg health, from DeepBook V3 (lib/server/peg.ts).
 *
 * `moneyJson`, as every money route answers: a bigint anywhere in the body
 * would make the plain responder throw — see lib/server/json.ts.
 */
export async function GET() {
  const pegStatus = await getPegStatus();

  return moneyJson(pegStatus, { headers: { 'Cache-Control': 'no-store' } });
}
