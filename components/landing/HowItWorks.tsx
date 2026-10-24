'use client';

import Image from 'next/image';
import { useState } from 'react';
import { ChevronRight, CreditCard, Landmark, Wallet } from 'lucide-react';

/**
 * How it works (v2 brief section 6): the two kinds of transfer, the Splash
 * Wallet they are paid from, and the five steps every payment takes. The
 * steps are the same for both kinds; where a step differs between a bank
 * payout and a stablecoin payment, it says what happens for the kind chosen.
 *
 * Funding providers are named only when their agreements are signed: the
 * page passes the signed names (`fundingPartners`), empty by default.
 */

type Kind = 'bank' | 'wallet';

const KINDS: Array<{ id: Kind; label: string; detail: string }> = [
  { id: 'bank', label: 'To a bank', detail: 'Stablecoin in, local currency out: pesos or rupiah to a supplier’s business bank account.' },
  { id: 'wallet', label: 'To a Splash business or a wallet', detail: 'Stablecoin to stablecoin: USDC to another business on Splash, or to a wallet address.' },
];

type Step = {
  id: string;
  title: string;
  bank: string;
  wallet: string;
  image: { bank: string; wallet: string };
  alt: string;
};

const STEPS: Step[] = [
  {
    id: 'choose',
    title: 'Choose who you are paying',
    bank: 'A supplier’s business bank account in the Philippines or Indonesia, from an invoice or typed in by hand.',
    wallet: 'A business on Splash, or a wallet address: on Sui, or USDC on another chain.',
    image: { bank: '/cinematic/flow-collect-v4.png', wallet: '/cinematic/flow-collect-v4.png' },
    alt: 'An invoice and a payment link beside a stack of dollar coins',
  },
  {
    id: 'check',
    title: 'Splash checks the recipient',
    bank: 'KYB on the supplier, and the bank details checked against what Philippine and Indonesian banks require.',
    wallet: 'KYB on a Splash business. For a wallet address, the owner’s business details, a signed ownership proof and a screening check.',
    image: { bank: '/cinematic/flow-review-quotes-v4.png', wallet: '/cinematic/flow-review-quotes-v4.png' },
    alt: 'Quote cards, a checklist and an approval stamp',
  },
  {
    id: 'wallet',
    title: 'The money comes from your Splash Wallet',
    bank: 'Stablecoins your business holds in its own wallet. Splash has no key to your Splash Wallet.',
    wallet: 'Stablecoins your business holds in its own wallet. Splash has no key to your Splash Wallet.',
    image: { bank: '/cinematic/treasury-island.png', wallet: '/cinematic/treasury-island.png' },
    alt: 'A floating vault of reserves with coins around it',
  },
  {
    id: 'sign',
    title: 'A person signs',
    bank: 'Your owners sign together, or a staff member pays inside a spending rule they set. Amount, payee and rate are fixed at approval.',
    wallet: 'Your owners sign together, or a staff member pays inside a spending rule they set. Amount and payee are fixed at approval.',
    image: { bank: '/cinematic/flow-settle-v4.png', wallet: '/cinematic/flow-settle-v4.png' },
    alt: 'A coin passing an approval gate beside a signing pen',
  },
  {
    id: 'pay',
    title: 'One Sui transaction pays and records it',
    bank: 'All or nothing, on Sui. The partner of record then credits the bank account in local currency, and Splash tracks it until the partner confirms.',
    wallet: 'All or nothing, on Sui, in seconds. The receipt is written in the same transaction as the payment.',
    image: { bank: '/cinematic/flow-deliver-v4.png', wallet: '/cinematic/flow-proof-v4.png' },
    alt: 'A delivery truck bringing a coin to a local shop, and a sealed receipt',
  },
];

export default function HowItWorks({ fundingPartners }: { fundingPartners: readonly string[] }) {
  const [kind, setKind] = useState<Kind>('bank');
  const [active, setActive] = useState(STEPS[0].id);
  const step = STEPS.find((s) => s.id === active) ?? STEPS[0];
  const index = STEPS.indexOf(step);

  return (
    <div className="iso-shell iso-flow-layout hw-layout">
      <div className="iso-flow-copy">
        <h2 className="iso-section-title iso-section-title-light" id="how-title">
          Five steps.
          <span>No limbo.</span>
        </h2>

        <div className="hw-kinds" role="radiogroup" aria-label="Kind of transfer">
          {KINDS.map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={kind === k.id ? 'is-on' : undefined} onClick={() => setKind(k.id)}>
              <strong>{k.label}</strong>
              <span>{k.detail}</span>
            </button>
          ))}
        </div>

        <div className="iso-flow-tabs" role="tablist" aria-label="The five steps">
          {STEPS.map((s, i) => {
            const on = s.id === step.id;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`hw-tab-${s.id}`}
                aria-selected={on}
                aria-controls="hw-panel"
                tabIndex={on ? 0 : -1}
                className={on ? 'is-active' : ''}
                onClick={() => setActive(s.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                  event.preventDefault();
                  const next = STEPS[(i + (event.key === 'ArrowDown' ? 1 : STEPS.length - 1)) % STEPS.length];
                  setActive(next.id);
                  document.getElementById(`hw-tab-${next.id}`)?.focus();
                }}
              >
                <span>{i + 1}</span>
                <strong>{s.title}</strong>
                <ChevronRight aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>

      <div className="hw-right">
        <div className="iso-flow-visual" role="tabpanel" id="hw-panel" aria-labelledby={`hw-tab-${step.id}`} aria-live="polite">
          <div className="iso-flow-image">
            <Image key={`${step.id}-${kind}`} src={step.image[kind]} alt={step.alt} width={1448} height={1086} sizes="(max-width: 900px) 92vw, 640px" />
          </div>
          <div className="iso-flow-caption">
            <span>{index + 1}</span>
            <div>
              <strong>{step.title}</strong>
              <p>{step[kind]}</p>
            </div>
          </div>
        </div>

        <aside className="hw-wallet" aria-labelledby="hw-wallet-title">
          <h3 id="hw-wallet-title">Your Splash Wallet</h3>
          <p>Stablecoins only, held by your business. Add funds three ways:</p>
          <ul>
            <li><CreditCard aria-hidden="true" />By card</li>
            <li><Landmark aria-hidden="true" />By bank transfer</li>
            <li><Wallet aria-hidden="true" />From another wallet</li>
          </ul>
          {fundingPartners.length > 0 ? <p className="hw-wallet-partners">Through {fundingPartners.join(', ')}.</p> : null}
        </aside>
      </div>
    </div>
  );
}
