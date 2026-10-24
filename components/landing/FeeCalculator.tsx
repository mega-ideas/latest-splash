'use client';

import { useMemo, useState } from 'react';

import FeeBreakdown from '@/components/fees/FeeBreakdown';
import { scheduleFromWire, scheduleToWire, type FeeScheduleWire } from '@/lib/fees/copy';
import { feeQuoteToWire } from '@/lib/fees/quote';
import { LAUNCH_SCHEDULE } from '@/lib/fees/schedule';
import { SPLASH_LEG, estimatePayment, formatBps } from '@/lib/fx/calculator';
import { getComparisonBaseline } from '@/lib/fx/comparison-baselines';
import { MoneyError, formatMinor, parseMinor } from '@/lib/money';

/**
 * What it costs to send one amount, on the one leg Splash prices.
 *
 * Splash's fee is the fee breakdown every surface shows (Amendment A1 §2.7):
 * Splash's fee with its kind and tier, the payout partner's fee with its
 * source, the total debited. It is computed from `schedule`, which the page
 * reads from the FeeConfig in force and hands down as data, so no rate is
 * typed in here. Beside it, a bank wire from a named, dated dataset: a
 * category, never a competitor. No exchange rate is assumed, so no peso
 * figure is shown: the rate is quoted when the customer sends. All
 * arithmetic is bigint minor units through lib/money.ts.
 */

const PRESETS = ['500', '1000', '5000', '25000'] as const;
const BASELINE = getComparisonBaseline('PHP');
const LAUNCH_WIRE = scheduleToWire(LAUNCH_SCHEDULE);

function usd(minor: bigint): string {
  const [whole, fraction] = formatMinor(minor, 2).split('.');
  return `US$${Number(whole).toLocaleString('en-US')}.${fraction}`;
}

export default function FeeCalculator({ schedule = LAUNCH_WIRE }: { schedule?: FeeScheduleWire }) {
  const [amount, setAmount] = useState<string>('1000');
  const fees = useMemo(() => scheduleFromWire(schedule), [schedule]);

  const parsed = useMemo(() => {
    const cleaned = amount.replace(/[,\s]/g, '');
    if (!cleaned) return { minor: null, error: 'Enter an amount in US dollars.' };
    try {
      const minor = parseMinor(cleaned, 2, 'half-up');
      if (minor <= 0n) return { minor: null, error: 'Enter an amount above zero.' };
      if (minor > 100_000_000_00n) return { minor: null, error: 'For amounts above US$100 million, ask us for a quote.' };
      return { minor, error: null };
    } catch (error) {
      return { minor: null, error: error instanceof MoneyError ? 'Enter a dollar amount, like 1000 or 2500.50.' : 'Enter a dollar amount.' };
    }
  }, [amount]);

  const estimate = parsed.minor ? estimatePayment({ amountUsdMinor: parsed.minor, baseline: BASELINE, fxRate: null, schedule: fees }) : null;

  return (
    <div className="ld-calc">
      <div className="ld-calc-field">
        <label htmlFor="calc-amount">Amount to send, in US dollars</label>
        <div className="ld-calc-input">
          <span aria-hidden="true">US$</span>
          <input
            id="calc-amount"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-describedby="calc-note"
          />
        </div>
        <div className="ld-chips" role="group" aria-label="Common amounts">
          {PRESETS.map((preset) => (
            <button
              type="button"
              key={preset}
              aria-pressed={amount.replace(/[,\s]/g, '') === preset}
              onClick={() => setAmount(preset)}
            >
              US${Number(preset).toLocaleString('en-US')}
            </button>
          ))}
        </div>
        {parsed.error ? <p className="ld-calc-error" role="alert">{parsed.error}</p> : null}
      </div>

      <div>
        <div className="ld-calc-rows" aria-live="polite">
          <div className="ld-calc-row ld-calc-row-splash ld-calc-row-stack">
            <div>
              <strong>Splash ({SPLASH_LEG.label})</strong>
              <small>A payout to a bank, {SPLASH_LEG.leg}. The fee comes from the published schedule and is charged on top.</small>
            </div>
            {estimate ? (
              <FeeBreakdown quote={feeQuoteToWire(estimate.splash.quote)} label="Splash's fee on this amount" />
            ) : (
              <p className="ld-calc-empty">Enter an amount to see the fee.</p>
            )}
          </div>

          {estimate?.bankWire ? (
            <div className="ld-calc-row">
              <div>
                <strong>Bank wire, USD to PHP</strong>
                <small>
                  Category figure from {estimate.bankWire.dataset.name}, as of {estimate.bankWire.dataset.asOf}. Delivery{' '}
                  {estimate.bankWire.delivery}. All-in.
                </small>
              </div>
              <div className="ld-calc-cost">
                <strong>{usd(estimate.bankWire.costMinor)}</strong>
                <small>{formatBps(estimate.bankWire.effectiveBps)} all-in on this amount</small>
              </div>
            </div>
          ) : null}
        </div>
        <p className="ld-fine" id="calc-note">
          Illustrative until you get a quote. The payout partner quotes its own fee, and the exchange rate,
          when you send; neither is included here, so no peso figure is shown. Neither row includes
          converting another currency into US dollars first.
        </p>
      </div>
    </div>
  );
}
