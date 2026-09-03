'use client';

import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import Wordmark from '@/components/brand/Wordmark';
import {
  AmountInput,
  Badge,
  BentoCell,
  BentoGrid,
  Button,
  Card,
  ChatComposer,
  Checkbox,
  Chip,
  EmptyState,
  FieldGroup,
  Input,
  PillToggle,
  PolicyCard,
  ProofDrawer,
  ProofRow,
  Radio,
  Select,
  SettlementTimeline,
  Skeleton,
  Stat,
  StepStrip,
  Switch,
  Table,
  Textarea,
  ThemeToggle,
} from '@/components/system';

const sampleRows = [
  { id: 'r1', when: '2026-09-02 09:14', corridor: 'USD → PHP', amount: '1,250.00', state: 'Settled', digest: '8f3a…c21e' },
  { id: 'r2', when: '2026-09-02 08:02', corridor: 'USD → IDR', amount: '18,400.00', state: 'Paid out', digest: '1b77…90aa' },
  { id: 'r3', when: '2026-09-01 17:45', corridor: 'USD → PHP', amount: '640.00', state: 'Returned', digest: 'ce02…4d10' },
];

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-[var(--divider)] py-8">
      <div>
        <h2 className="text-[var(--text-h2)] font-semibold tracking-[-0.02em] text-[var(--text)]">{title}</h2>
        {note ? <p className="mt-1 max-w-[65ch] text-[14px] text-[var(--text-2)]">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Pane({ theme, children }: { theme: 'light' | 'dark'; children: React.ReactNode }) {
  return (
    <div data-theme={theme} className="rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--paper)] p-5 text-[var(--text)]">
      <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">{theme}</p>
      <div className="grid gap-4">{children}</div>
    </div>
  );
}

function Both({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Each pane owns a form so a radio group in a specimen does not pair
          with its twin in the other theme. */}
      <Pane theme="light"><form onSubmit={(event) => event.preventDefault()} className="grid gap-4">{children}</form></Pane>
      <Pane theme="dark"><form onSubmit={(event) => event.preventDefault()} className="grid gap-4">{children}</form></Pane>
    </div>
  );
}

export default function DesignGallery() {
  const [mode, setMode] = useState<'send' | 'batch'>('send');
  const [sweep, setSweep] = useState(true);
  const [amount, setAmount] = useState('1250');

  return (
    <main className="min-h-screen bg-[var(--paper)] px-4 py-10 text-[var(--text)] md:px-8">
      <div className="mx-auto max-w-[1200px]">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Wordmark />
          <span className="font-mono text-[12px] text-[var(--text-muted)]">design system · Palette v2 · Geist</span>
        </div>
        <ThemeToggle />
      </header>

      <Section title="Type scale" note="Geist for UI and headlines; Geist Mono for digests, module chips, IDs and tabular money.">
        <Both>
          <p className="text-[var(--text-display)] font-semibold leading-[1.05] tracking-[-0.02em]">
            Send USD across Southeast Asia
            <span className="block text-[var(--text-2)]">in minutes.</span>
          </p>
          <p className="text-[var(--text-h1)] font-semibold leading-[1.1]">H1 · settlement, proven on-chain</p>
          <p className="text-[var(--text-h2)] font-semibold leading-[1.15]">H2 · one atomic transaction</p>
          <p className="text-[var(--text-h3)] font-semibold">H3 · pay · allocate · prove</p>
          <p className="text-[16px] leading-[1.55] text-[var(--text-2)]">Body 16/1.55. A human approves every action. Corridor fee and speed figures are illustrative.</p>
          <p className="text-[13px] font-medium tracking-[0.01em] text-[var(--text-muted)]">Caption 13 · +0.01em</p>
          <p className="font-mono text-[13px]">mono · 0x8f3a…c21e · payment_intent · 1,250.00</p>
        </Both>
      </Section>

      <Section title="Form controls" note="Visible label, help below, error under the field it belongs to. Focus is an offset ring; disabled is a muted surface, not the live one at half strength.">
        <Both>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Business name" placeholder="Supplier legal name" help="The legal name on the bank account." required />
            <Input label="Amount" prefix="USD" mono inputMode="decimal" placeholder="0.00" defaultValue="5,000.00" />
            <Input label="SWIFT / BIC" placeholder="BOPIPHMM" optional mono />
            <Input label="Account number" defaultValue="1234-5678" error="This account failed verification with the partner bank." mono />
            <Select label="Corridor" help="Only corridors with active partner controls can execute.">
              <option>USD → PHP · sandbox</option>
              <option>USD → IDR · staged</option>
            </Select>
            <Input label="Reference" defaultValue="INV-77122" readOnly help="Set when the invoice was issued." />
            <Input label="Payout rail" defaultValue="Partner rail" disabled help="Chosen by policy for this corridor." />
            <Textarea label="Note for the checker" placeholder="Optional · recorded with the decision" rows={3} />
          </div>
          <FieldGroup legend="Approval" help="Applies to every payment above the threshold.">
            <Checkbox label="Require a second approver" help="Maker and checker must be different people." defaultChecked />
            <Checkbox label="Require TOTP on approval" />
            <Checkbox label="Block high-risk corridors" disabled help="Locked by your compliance policy." />
          </FieldGroup>
          <FieldGroup legend="Funding source">
            <Radio name="gallery-funding" label="Held balance" help="Settles immediately, discounted fee." defaultChecked />
            <Radio name="gallery-funding" label="Bank USD" help="Waits for the deposit to clear." />
          </FieldGroup>
          <Switch checked={sweep} onCheckedChange={setSweep} label="Sweep idle balance nightly" help="Applies as soon as you turn it on." />
        </Both>
      </Section>

      <Section title="Buttons and toggles" note="One primary per screen. Ghost for secondary, destructive as text. 44px targets.">
        <Both>
          <div className="flex flex-wrap items-center gap-3">
            <Button>Open payment desk</Button>
            <Button variant="ghost">See how it settles</Button>
            <Button variant="destructive-text">Reject</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button disabled>Disabled</Button>
            <Button loading loadingLabel="Creating proposal…">Create proposal</Button>
            <Button variant="secondary" iconOnly aria-label="Refresh quote">
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
          <PillToggle
            label="Flow"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'send', label: 'Send' },
              { value: 'batch', label: 'Batch payout' },
            ]}
          />
        </Both>
      </Section>

      <Section title="Badges and chips" note="Badges carry state in words, never colour alone. Chips are mono and name infrastructure or modules.">
        <Both>
          <div className="flex flex-wrap gap-2">
            <Badge tone="green">Settled</Badge>
            <Badge tone="amber">Pending</Badge>
            <Badge tone="slate">Draft</Badge>
            <Badge tone="red">Returned</Badge>
            <Badge tone="teal">Live on Sui mainnet</Badge>
            <Badge tone="amber" outline>Legacy rails: 2–3 days</Badge>
            <Badge tone="green" outline>Splash: minutes, end to end*</Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            <Chip>payment_intent</Chip>
            <Chip>PTB batch</Chip>
            <Chip tone="teal">Live FX via Pyth</Chip>
            <Chip tone="green">audit_anchor + receipt_v2</Chip>
            <Chip ghost>More corridors</Chip>
          </div>
        </Both>
      </Section>

      <Section title="Cards, stats, bento" note="Cards only where elevation communicates hierarchy. Exactly one dark card per composition. Amount > currency > label, tabular numerals.">
        <Both>
          <BentoGrid>
            <BentoCell span={2}>
              <Stat label="Available balance" value="42,180.00" currency="USD claim" sub="Ready to spend · no notice period" />
            </BentoCell>
            <BentoCell span={2} tone="tint">
              <Stat label="Pending outflows" value="18,400.00" currency="USDC" tone="pending" />
            </BentoCell>
            <BentoCell span={2} tone="dark">
              <Stat label="Awaiting approval" value="3" tone="default" className="text-white [&_span]:text-white" />
              <p className="mt-2 text-[13px] text-white/70">agent proposes → human approves → deterministic execution</p>
            </BentoCell>
            <BentoCell span={3}>
              <Stat label="Loading money" value={null} currency="USDY" loading />
            </BentoCell>
            <BentoCell span={3} elevated>
              <Card tone="tint" padding="sm">Elevated cell with a tinted inner card.</Card>
            </BentoCell>
          </BentoGrid>
        </Both>
      </Section>

      <Section title="Inputs and steps" note="Label above, helper below, error below. 16px minimum. Steps only for real sequences.">
        <Both>
          <AmountInput label="Amount" value={amount} onChange={setAmount} currency="USD" helper="Illustrative fee 0.80% · varies by corridor and volume" />
          <AmountInput label="Amount" value="12" onChange={() => {}} currency="USD" error="Below the minimum settlement of 25 USD." />
          <StepStrip
            steps={[{ label: 'Instruct' }, { label: 'Screen', detail: 'KYB · sanctions · travel rule' }, { label: 'Settle', detail: 'Sui PTB' }, { label: 'Deliver', detail: 'licensed partner' }, { label: 'Pay out', detail: 'local rails' }]}
            current={2}
            footnote="on-chain settlement ~400ms · delivery per local rail*"
          />
        </Both>
      </Section>

      <Section title="Table" note="Money-aligned; rows become cards below md; CSV export on every table.">
        <Both>
          <Table
            caption="Recent settlements"
            exportName="settlements"
            rows={sampleRows}
            columns={[
              { key: 'when', header: 'When', mono: true, secondary: true },
              { key: 'corridor', header: 'Corridor' },
              { key: 'amount', header: 'Amount (USD)', align: 'right', mono: true },
              {
                key: 'state',
                header: 'State',
                render: (row) => (
                  <Badge tone={row.state === 'Settled' || row.state === 'Paid out' ? 'green' : row.state === 'Returned' ? 'red' : 'amber'}>{row.state}</Badge>
                ),
              },
              { key: 'digest', header: 'Digest', mono: true, secondary: true },
            ]}
            rowAction={() => (
              <Button variant="ghost" size="sm">
                Proof
              </Button>
            )}
          />
          <Table caption="Empty table" rows={[]} columns={[{ key: 'x', header: 'X' }]} emptyState={<EmptyState title="No settlements yet" body="Send your first payout and it appears here with its proof." action={<Button size="sm">Send USD</Button>} />} />
        </Both>
      </Section>

      <Section title="Proof drawer and settlement timeline" note="D7 states for the sui-native rail with a returned branch; the drawer is the only place raw chain vocabulary appears.">
        <Both>
          <SettlementTimeline
            rail="sui-native"
            entries={[
              { state: 'INTENT_CREATED', at: '2026-09-02T01:14:00Z' },
              { state: 'FUNDED', at: '2026-09-02T01:15:10Z' },
              { state: 'SETTLED_ON_SUI', at: '2026-09-02T01:15:11Z', evidence: { label: 'Sui digest', value: '8f3a…c21e', href: '#' } },
              { state: 'DELIVERED_TO_EXCHANGE', at: '2026-09-02T01:16:00Z' },
            ]}
          />
          <SettlementTimeline
            rail="cctp"
            compact
            entries={[
              { state: 'INTENT_CREATED', at: '2026-09-01T09:00:00Z' },
              { state: 'FUNDED', at: '2026-09-01T09:01:00Z' },
              { state: 'SETTLED_ON_SUI', at: '2026-09-01T09:01:01Z' },
              { state: 'BURNED', at: '2026-09-01T09:02:00Z' },
              { state: 'HOP_STUCK', at: '2026-09-01T09:40:00Z' },
            ]}
          />
          <ProofDrawer>
            <dl>
              <ProofRow label="Sui digest" value="8f3aA1…c21e" mono href="#" />
              <ProofRow label="Walrus blob" value="0x91…ef" mono />
              <ProofRow label="Content hash" value="sha256:4c…9a" mono />
            </dl>
          </ProofDrawer>
        </Both>
      </Section>

      <Section title="Policy card and composer" note="Policies gate execution; the composer prepares proposals. The boundary is visible in the copy.">
        <Both>
          <PolicyCard
            title="Per-transfer limit"
            scope="All corridors · finance team"
            rule="Any single payout above 5,000 USD requires a second approver before the PTB is signed."
            chips={['maker-checker', 'spend_meter']}
            action={<Button variant="ghost" size="sm">Edit policy</Button>}
          />
          <ChatComposer onSubmit={() => {}} onAttach={() => {}} hint="0xWal prepares · you approve" />
        </Both>
      </Section>

      <Section title="Empty state and skeletons" note="Empty screens invite the one action that fills them; skeletons reserve the final shape.">
        <Both>
          <EmptyState title="No recipients yet" body="Add a verified counterparty to send your first payout." action={<Button size="sm">Add recipient</Button>} />
          <div className="grid gap-3">
            <Skeleton variant="money" />
            <Skeleton variant="text" lines={3} />
            <Skeleton />
          </div>
        </Both>
      </Section>
      </div>
    </main>
  );
}
