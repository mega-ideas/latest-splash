import { RATE_LIMITS, clientIp, enforceRateLimit } from '@/lib/server/rate-limit';
import { handleDemoSeller } from '@/lib/server/x402-demo-seller';

export const dynamic = 'force-dynamic';

/** The Splash demo x402 seller (lib/server/x402-demo-seller.ts). Public. */
export async function GET(request: Request) {
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.x402DemoIp, key: clientIp(request) });
  if (limited) return limited;
  return handleDemoSeller(request);
}
