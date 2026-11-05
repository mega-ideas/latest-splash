import { feeBreakdownRows } from '@/lib/fees/copy';
import type { FeeQuoteWire } from '@/lib/fees/quote';

/**
 * Splash's fee, broken down the same way on every surface that shows it
 * (Amendment A1 §2.7): the calculator, the transfer review and the receipt.
 *
 *   Splash fee           <kind> · <band of principal> · <rate>      <amount>
 *   Payout-partner fee   <who quoted it>                           <amount>
 *   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
 *   Total debited                                                  <amount>
 *
 * Every word and number comes from the quote (lib/fees/copy.ts
 * `feeBreakdownRows`), which comes from the schedule: nothing here is typed
 * in. The total sits under the dashed rule the receipt uses for its
 * perforation, so the three surfaces read as one record.
 *
 * Colours are the brand tokens at text contrast on white and on --bg (the
 * review card): ink (#1F4452) for labels and amounts, slate (#326273, 5.9:1
 * on --bg and 6.6:1 on white) for the detail line.
 */
export default function FeeBreakdown({
  quote,
  className = '',
  label = "Splash's fee and what is debited",
}: {
  quote: FeeQuoteWire;
  className?: string;
  /** The list's accessible name. */
  label?: string;
}) {
  const rows = feeBreakdownRows(quote);
  return (
    <dl aria-label={label} className={`grid gap-2.5 text-sm ${className}`}>
      {rows.map((row) =>
        row.key === 'total' ? (
          <div key={row.key} className="mt-1 flex items-baseline justify-between gap-4 border-t border-dashed border-[#C9BDB5] pt-3">
            <dt className="font-semibold text-[#1F4452]">{row.label}</dt>
            <dd className="money text-base font-semibold text-[#1F4452]">{row.amount}</dd>
          </div>
        ) : (
          <div key={row.key} className="flex items-baseline justify-between gap-4">
            <dt className="min-w-0">
              <span className="block font-medium text-[#1F4452]">{row.label}</span>
              {row.detail ? <span className="mt-0.5 block text-[13px] leading-5 text-[#326273]">{row.detail}</span> : null}
            </dt>
            <dd className="money shrink-0 text-right font-medium text-[#1F4452]">{row.amount}</dd>
          </div>
        ),
      )}
    </dl>
  );
}
