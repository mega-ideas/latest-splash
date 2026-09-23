import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

/**
 * Public explainer for the SHIPPED 0xWal control plane, in the §S card
 * grammar (iso-ctrl-card = meta / art / copy).
 * Every phase renders the actual ProposalStatus values from
 * lib/agent/types.ts — the UI matches the engine, not a marketing diagram
 * of it. The implementing file paths used to render on every card too;
 * a visitor reading a landing page does not need source paths, so the
 * states stayed and the paths went.
 */
const PHASES = [
  {
    number: '01',
    title: 'Propose',
    copy: '0xWal drafts an unsigned proposal and dry-runs it against live balances. Gas is sponsored — nothing is signed, nothing moves.',
    states: ['DRAFTED', 'SIMULATED'],
    image: '/isometric/ctrl-propose.png',
    imageAlt: 'Isometric AI robot drafting an unsigned proposal with a pen',
  },
  {
    number: '02',
    title: 'Policy',
    copy: 'Deterministic rules — approval thresholds, corridor arm/pause state, operating minimums — evaluate the proposal. Code, not judgement.',
    states: ['POLICY_EVALUATED'],
    image: '/isometric/ctrl-policy.png',
    imageAlt: 'Isometric policy engine evaluating a document against threshold sliders and toggles',
  },
  {
    number: '03',
    title: 'Guards',
    copy: 'Anomaly screens, a circuit breaker, and a submit guard sit between the proposal and the queue. Any trip stops the pipeline.',
    states: ['PENDING_APPROVAL'],
    image: '/isometric/ctrl-guards.png',
    imageAlt: 'Isometric layered safety guards: an anomaly chart, a circuit-breaker switch, and a shield',
  },
  {
    number: '04',
    title: 'You approve',
    copy: 'A human signs in the Action Queue — maker-checker, with dual approval above your threshold. This is the only gate that releases money.',
    states: ['APPROVED', 'SIGNED'],
    image: '/isometric/ctrl-approve.png',
    imageAlt: 'Isometric maker-checker approval: a person stamping a document at a release gate',
  },
  {
    number: '05',
    title: 'Execute & prove',
    copy: 'The approved payment settles, and the encrypted evidence is written beside it where it cannot be quietly changed.',
    states: ['SUBMITTED', 'SETTLED', 'ANCHORED'],
    image: '/isometric/ctrl-execute.png',
    imageAlt: 'Isometric settlement dock linking a sealed evidence document to an on-chain block chain',
  },
];

export default function ControlPlaneExplainer() {
  return (
    <div className="iso-ctrl">
      <div className="iso-ctrl-claim">
        <p>
          <strong>0xWal prepares, you approve.</strong> 0xWal never moves money — deterministic
          policy and your approval do. This pipeline is shipped code, not a roadmap.
        </p>
        <Link href="/queue" className="iso-button iso-button-small">
          Open the Action Queue
          <ArrowRight aria-hidden="true" />
        </Link>
      </div>

      <ol className="iso-ctrl-grid">
        {PHASES.map((phase) => (
          <li className="iso-ctrl-card" key={phase.title}>
            <div className="iso-ctrl-meta">
              <span>{phase.number}</span>
              <p>{phase.title}</p>
            </div>
            <div className="iso-ctrl-art">
              <Image src={phase.image} alt={phase.imageAlt} width={480} height={360} />
            </div>
            <div className="iso-ctrl-copy">
              <p>{phase.copy}</p>
              <div className="iso-ctrl-states">
                {phase.states.map((state) => (
                  <code key={state}>{state}</code>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
