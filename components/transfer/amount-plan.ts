'use client';

import { useMemo } from 'react';

import { feeUnderConfig } from '@/lib/fees/schedule';
import { usePublishedFees } from '@/lib/fees/use-published-pricing';
import { feeKindOf } from '@/lib/transfer/payee';
import { fundsCheck, parseAmountMinor } from '@/lib/transfer/plan';
import type { Balance, Flow } from './flow';

/**
 * What the amount step knows about the payment so far, for the desktop step
 * and the phone's amount question alike: the amount, the kind of payment it
 * is, an estimate of Splash's fee from the published schedule (rounded up to
 * the cent; the real fee comes with the quote), and whether the wallet covers
 * both. The wallet balance is read from the chain, so an unread balance is
 * "not enough", never "enough".
 */
export function useAmountPlan(flow: Flow, balance: Balance) {
  const fees = usePublishedFees();
  const bank = flow.chosen?.kind === 'bank';
  const amount = parseAmountMinor(flow.amountText);
  const kind = flow.payeeType ? feeKindOf(flow.payeeType === 'wallet' ? { kind: 'wallet', wallet: flow.chosen?.kind === 'recipient' ? (flow.chosen.deliveryKind === 'EXCHANGE' ? 'exchange' : flow.chosen.deliveryKind === 'CROSS_CHAIN' ? 'cross_chain' : 'self_custody') : 'self_custody' } : { kind: flow.payeeType }) : null;
  const estimate = useMemo(() => {
    if (!fees || amount === null || kind === null) return null;
    try {
      return feeUnderConfig({ config: { feesOn: fees.feesOn, schedule: fees.schedule }, kind, principalMinor: amount, discountBps: 0 });
    } catch {
      return null;
    }
  }, [fees, amount, kind]);
  // An estimate is shown rounded up to the cent; the real fee comes with the quote.
  const estimateUp = estimate === null ? null : ((estimate + 9_999n) / 10_000n) * 10_000n;
  const funds = amount !== null && estimateUp !== null && balance.state === 'ok' ? fundsCheck({ balanceMinor: balance.usdcMinor, amountMinor: amount, feeMinor: estimateUp }) : null;
  return { fees, bank, amount, kind, estimateUp, funds };
}
