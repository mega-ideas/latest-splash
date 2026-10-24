import { Landmark, ReceiptText, Sprout } from 'lucide-react';

import RoadmapChip from '@/components/supply/RoadmapChip';

/**
 * /working-capital section 03, "Where Supply fits": the three loops as one
 * loop. Settle feeds Supply with settlement history, Supply hands freed cash
 * to Save, and Save is ready to settle again.
 *
 * Server-rendered and still. The connector lines are CSS borders on the
 * page itself, so the diagram is whole on first paint, in a screenshot and
 * with reduced motion: nothing waits for a scroll position to draw (the
 * scroll-drawn flywheel it replaces rendered empty until it was scrolled).
 */

type Node = {
  id: 'settle' | 'supply' | 'save';
  name: string;
  role: string;
  icon: typeof Landmark;
  status: 'live' | 'roadmap' | null;
  copy: string;
  meta: string;
};

const NODES: readonly Node[] = [
  {
    id: 'settle',
    name: 'Settle',
    role: 'Where it starts',
    icon: Landmark,
    status: 'live',
    copy: 'Pay suppliers in the Philippines and Indonesia. Every approved payment adds a verified counterparty and its settlement history.',
    meta: 'USDC to PHP and IDR',
  },
  {
    id: 'supply',
    name: 'Supply',
    role: 'Working capital',
    icon: ReceiptText,
    status: 'roadmap',
    copy: 'Invoices would become working capital: your buyer funds early payment against a receivable whose history both sides can read.',
    meta: 'Buyer-funded, no third-party lender',
  },
  {
    id: 'save',
    name: 'Save',
    role: 'Between payments',
    icon: Sprout,
    status: null,
    copy: 'Balances wait in your Splash Wallet until the next payment. Any treasury move needs your approval first.',
    meta: 'Your approval on every move',
  },
];

/** What travels along each connector, in order. */
const LINKS = ['settlement history', 'freed cash'] as const;

export default function SupplyLoop() {
  return (
    <figure className="wc-loop">
      <figcaption className="sr-only">
        The loop: Settle passes settlement history to Supply, Supply passes freed cash to Save, and Save is
        ready to settle again.
      </figcaption>
      <div className="wc-loop-track">
        {NODES.map((node, index) => (
          <div className="wc-loop-station" key={node.id}>
            <article className={`wc-loop-node is-${node.id}`}>
              <div className="wc-loop-head">
                <span className="wc-loop-icon"><node.icon aria-hidden="true" /></span>
                {node.status === 'roadmap' ? <RoadmapChip /> : null}
                {node.status === 'live' ? <span className="wc-loop-live">Live</span> : null}
              </div>
              <h3>
                {node.name}
                <span>{node.role}</span>
              </h3>
              <p>{node.copy}</p>
              <small>{node.meta}</small>
            </article>
            {index < LINKS.length ? (
              <div className="wc-loop-link" aria-hidden="true">
                <span>{LINKS[index]}</span>
                <i />
              </div>
            ) : null}
          </div>
        ))}
        <div className="wc-loop-return" aria-hidden="true">
          <span>ready to settle again</span>
        </div>
      </div>
    </figure>
  );
}
