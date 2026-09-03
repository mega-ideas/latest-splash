'use client';

import { useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Check, ReceiptText } from 'lucide-react';

/**
 * The signature element of /working-capital: a live-feeling but explicitly
 * illustrative "receivable" that dramatizes the one choice dynamic discounting
 * gives a supplier — hold the invoice to maturity for the full amount, or take
 * the buyer's early payment today at a small discount. Numbers are fixed and
 * labeled illustrative; this is a worked example, not a quote.
 */
const FACE = 100_000;
const DISCOUNT_PCT = 1.2;
const DISCOUNT = Math.round((FACE * DISCOUNT_PCT) / 100); // 1,200
const EARLY = FACE - DISCOUNT; // 98,800
const TENOR_DAYS = 90;
// Buyer's return for fronting their own approved cash ~90 days early.
const ANNUALIZED = ((DISCOUNT / EARLY) * (365 / TENOR_DAYS) * 100).toFixed(1); // ~4.9

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

type Choice = 'hold' | 'early';

const OUTCOMES: Record<
  Choice,
  {
    settles: string;
    receives: string;
    discount: string;
    note: string;
    highlight?: string;
  }
> = {
  hold: {
    settles: 'Day 90 · due date',
    receives: usd(FACE),
    discount: 'None',
    note: 'The full amount on the due date. Discounting is never obligatory — every invoice can simply run to maturity.',
  },
  early: {
    settles: 'Today · same rail',
    receives: usd(EARLY),
    discount: `${DISCOUNT_PCT}% · ${usd(DISCOUNT)}`,
    highlight: `Buyer earns ${usd(DISCOUNT)} on idle USD held ~${TENOR_DAYS} days — ≈ ${ANNUALIZED}% p.a.`,
    note: "The buyer's own approved USD, released early over Splash. No factoring house, no credit line, no lender between you.",
  },
};

export default function DiscountTermSheet() {
  const [choice, setChoice] = useState<Choice>('early');
  const reduce = useReducedMotion();
  const outcome = OUTCOMES[choice];

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      setChoice((c) => (c === 'hold' ? 'early' : 'hold'));
    }
  }

  return (
    <motion.figure
      className="wc-ticket"
      initial={reduce ? false : { opacity: 0, y: 28 }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
    >
      <figcaption className="wc-ticket-head">
        <span className="wc-ticket-tag">
          <ReceiptText aria-hidden="true" /> Receivable
        </span>
        <span className="wc-ticket-id">INV-4471 · Net 90</span>
      </figcaption>

      <div className="wc-ticket-face">
        <small>Invoice face value</small>
        <strong>{usd(FACE)}</strong>
      </div>

      <div
        className="wc-ticket-toggle"
        role="radiogroup"
        aria-label="Supplier settlement choice"
        onKeyDown={onKey}
      >
        <button
          type="button"
          role="radio"
          aria-checked={choice === 'hold'}
          tabIndex={choice === 'hold' ? 0 : -1}
          className={choice === 'hold' ? 'is-active' : ''}
          onClick={() => setChoice('hold')}
        >
          Hold to maturity
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={choice === 'early'}
          tabIndex={choice === 'early' ? 0 : -1}
          className={choice === 'early' ? 'is-active' : ''}
          onClick={() => setChoice('early')}
        >
          Take early payment
        </button>
        <span className="wc-ticket-thumb" data-choice={choice} aria-hidden="true" />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={choice}
          className="wc-ticket-outcome"
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
        >
          <dl className="wc-ticket-rows">
            <div>
              <dt>Settles</dt>
              <dd>{outcome.settles}</dd>
            </div>
            <div className="is-primary">
              <dt>Supplier receives</dt>
              <dd>{outcome.receives}</dd>
            </div>
            <div>
              <dt>Discount</dt>
              <dd>{outcome.discount}</dd>
            </div>
          </dl>
          {outcome.highlight ? (
            <p className="wc-ticket-highlight">
              <Check aria-hidden="true" /> {outcome.highlight}
            </p>
          ) : null}
          <p className="wc-ticket-note">{outcome.note}</p>
        </motion.div>
      </AnimatePresence>

      <div className="wc-ticket-foot">
        <span>Buyer-funded</span>
        <span>No lender</span>
        <span>Approval-gated</span>
        <em>Illustrative<ArrowRight aria-hidden="true" /></em>
      </div>
    </motion.figure>
  );
}
