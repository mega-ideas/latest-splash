/**
 * The live registration of the payment flow behind Pay invoices (v2 brief 5.8
 * into 5.4): the flow of lib/server/bill-payment-flow.ts, wired to this
 * org's own wallet context. Registered once for the process; until it is,
 * Pay invoices answers PAYMENT_FLOW_NOT_WIRED and nothing changes.
 */
import 'server-only';

import { billPaymentFlow, registerBillPaymentFlow, type BillPaymentFlow } from '@/lib/bills/payment-hook';
import { makeBillPaymentFlow } from '@/lib/server/bill-payment-flow';
import { liveWalletContext } from '@/lib/server/wallet-deps';
import { customerRefusal, refusalLogLine } from '@/lib/server/wallet-refusal';
import { transferDepsFor } from '@/lib/server/wallet-transfers-deps';

export function liveBillPaymentFlow(): BillPaymentFlow {
  if (billPaymentFlow().wired) return billPaymentFlow();
  registerBillPaymentFlow(
    makeBillPaymentFlow(async (orgId) => {
      const live = await liveWalletContext(orgId);
      if (!live.ok) {
        const line = refusalLogLine(orgId, live.error);
        if (line) console.warn(line);
        return { ok: false, ...customerRefusal(live) };
      }
      // A route's shape, for the one thing the service reads from it: the org's own context.
      return transferDepsFor({ orgId, ctx: live.ctx, db: live.db } as Parameters<typeof transferDepsFor>[0]);
    }),
  );
  return billPaymentFlow();
}
