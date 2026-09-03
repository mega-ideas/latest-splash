'use client';

import { useCallback, useEffect, useState } from 'react';

import AmountStep from '@/components/send/AmountStep';
import ProcessingStep from '@/components/send/ProcessingStep';
import ReceiptStep from '@/components/send/ReceiptStep';
import RecipientStep from '@/components/send/RecipientStep';
import ReviewStep from '@/components/send/ReviewStep';
import RouteStep from '@/components/send/RouteStep';
import { Card, StepStrip } from '@/components/system';
import { COUNTRY_TO_CURRENCY, initialTransferState, type TransferState } from '@/lib/send/state';

const STEPS = [{ label: 'Beneficiary' }, { label: 'Amount' }, { label: 'Route' }, { label: 'Review' }, { label: 'Processing' }, { label: 'Receipt' }];

/**
 * Send: recipient → amount → review → processing → receipt. The state is one
 * object held in memory; deep links (?invoiceId, ?holdId) prefill it.
 */
export default function SendPage() {
  const [state, setState] = useState<TransferState>(initialTransferState);
  const set = useCallback((patch: Partial<TransferState>) => setState((previous) => ({ ...previous, ...patch })), []);
  const go = useCallback((step: TransferState['step']) => set({ step }), [set]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invoiceId = params.get('invoiceId');
    const holdId = params.get('holdId');
    const recipientId = params.get('recipient');
    if (recipientId) {
      void fetch('/api/recipients', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : []))
        .then((records: Array<{ id: string; name: string; country: string; swift: string; account: string; tier: TransferState['deliveryTier'] }>) => {
          const record = records.find((entry) => entry.id === recipientId);
          if (!record) return;
          const country = (['MY', 'PH', 'ID', 'SG', 'VN', 'TH', 'EU', 'GB'].includes(record.country.toUpperCase()) ? record.country.toUpperCase() : 'PH') as TransferState['recipient']['country'];
          setState((current) => ({
            ...current,
            step: 2,
            recipient: { ...current.recipient, name: record.name, country, rail: 'bank', bank: { swift: record.swift ?? '', account: record.account ?? '' } },
            amount: { ...current.amount, targetCurrency: COUNTRY_TO_CURRENCY[country] },
            deliveryTier: record.tier,
          }));
        });
    }
    if (invoiceId) {
      void fetch(`/api/invoices/${invoiceId}`)
        .then((response) => response.json())
        .then((invoice: { payerOrgName?: string; amountUsd?: string; targetCurrency?: TransferState['amount']['targetCurrency']; id?: string }) => {
          if (!invoice.id) return;
          setState((current) => ({
            ...current,
            step: 2,
            invoiceId: invoice.id,
            recipient: { ...current.recipient, name: invoice.payerOrgName ?? current.recipient.name, country: 'PH' },
            amount: { ...current.amount, value: invoice.amountUsd ?? current.amount.value, targetCurrency: invoice.targetCurrency ?? current.amount.targetCurrency },
            deliveryTier: invoice.targetCurrency === 'PHP' ? 'SWEEP_ACCOUNT' : 'PAYOUT_ONLY',
          }));
        });
    }
    if (holdId) {
      void fetch(`/api/rate-holds?id=${encodeURIComponent(holdId)}`)
        .then((response) => response.json())
        .then((hold: TransferState['rateHold']) => {
          if (!hold?.id || hold.state !== 'ACTIVE') return;
          setState((current) => ({ ...current, rateHold: hold, amount: { ...current.amount, targetCurrency: hold.corridorCurrency as TransferState['amount']['targetCurrency'] } }));
        });
    }
  }, []);

  return (
    <div className="mx-auto grid w-full max-w-[880px] gap-6">
      <header>
        <h1 className="text-[28px] font-semibold leading-[1.1] tracking-[-0.02em] md:text-[32px]">New cross-border payment</h1>
        <p className="mt-1 text-[14px] text-[var(--text-2)]">Build an evidence-backed instruction before funds move. Creation does not move funds; checker approval is required.</p>
      </header>
      <StepStrip steps={STEPS} current={state.step - 1} />
      <Card padding="lg">
        {state.step === 1 ? <RecipientStep state={state} set={set} next={() => go(2)} /> : null}
        {state.step === 2 ? <AmountStep state={state} set={set} prev={() => go(1)} next={() => go(3)} /> : null}
        {state.step === 3 ? <RouteStep state={state} prev={() => go(2)} next={() => go(4)} /> : null}
        {state.step === 4 ? <ReviewStep state={state} set={set} prev={() => go(3)} next={() => go(5)} /> : null}
        {state.step === 5 ? <ProcessingStep state={state} set={set} next={() => go(6)} retry={() => setState({ ...initialTransferState, recipient: state.recipient, amount: state.amount })} /> : null}
        {state.step === 6 ? <ReceiptStep state={state} reset={() => setState(initialTransferState)} /> : null}
      </Card>
    </div>
  );
}
