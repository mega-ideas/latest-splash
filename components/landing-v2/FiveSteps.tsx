import Reveal from './Reveal';
import { Section, TwoTone } from './ui';

const STEPS = [
  { label: 'Instruct', detail: 'Invoice, batch file or a prompt to 0xWal' },
  { label: 'Screen', detail: 'KYB · sanctions · travel rule' },
  { label: 'Settle', detail: 'Sui PTB: pay · allocate · prove' },
  { label: 'Deliver', detail: 'Licensed payout partner per corridor' },
  { label: 'Pay out', detail: 'Local rails to the supplier bank' },
];

/**
 * Five-step strip (§3.4). Horizontal strip with a labelled bar on desktop,
 * vertical timeline below md. The order is the order money moves, so the
 * connecting line is the information, not decoration.
 */
export default function FiveSteps() {
  return (
    <Section id="five-steps" labelledBy="five-steps-title">
      <Reveal>
        <TwoTone id="five-steps-title" line1="Five steps." line2="Every one of them leaves a record." />
      </Reveal>
      <Reveal delay={0.05} className="mt-10">
        <ol className="relative grid gap-6 border-l-2 border-[var(--divider)] pl-6 md:grid-cols-5 md:gap-4 md:border-l-0 md:border-t-2 md:pl-0 md:pt-6">
          {STEPS.map((step, index) => (
            <li key={step.label} className="relative">
              <span className="absolute -left-[31px] top-1 grid size-4 place-items-center rounded-full border-2 border-[var(--teal-600)] bg-[var(--paper)] md:-top-[31px] md:left-0" aria-hidden="true">
                <span className={index === 2 ? 'size-1.5 rounded-full bg-[var(--teal-600)]' : ''} />
              </span>
              <div className="font-mono text-[12px] text-[var(--text-muted)]">0{index + 1}</div>
              <h3 className="mt-1 text-[17px] font-semibold">{step.label}</h3>
              <p className="mt-1 text-[14px] text-[var(--text-2)]">{step.detail}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 inline-flex items-center gap-2 rounded-[999px] border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 font-mono text-[12px] text-[var(--text-2)]">
          <span className="size-1.5 rounded-full bg-[var(--green-600)]" aria-hidden="true" />
          on-chain settlement ~400ms · delivery per local rail*
        </p>
      </Reveal>
    </Section>
  );
}
