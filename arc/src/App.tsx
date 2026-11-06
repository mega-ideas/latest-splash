import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { ShieldCheck } from 'lucide-react'
import type { Hex } from 'viem'
import { ESCROW_ADDRESS } from '@/lib/escrow'
import { PayerScreen } from '@/components/PayerScreen'
import { PaymentTimeline } from '@/components/PaymentTimeline'
import { BeneficiaryScreen } from '@/components/BeneficiaryScreen'
import { AddressChip, Notice } from '@/components/ui'

type Tab = 'pay' | 'payments' | 'acknowledge'

const TABS: { id: Tab; label: string }[] = [
  { id: 'pay', label: 'Pay' },
  { id: 'payments', label: 'Payments' },
  { id: 'acknowledge', label: 'Acknowledge' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('pay')
  const [tracked, setTracked] = useState<Hex | undefined>()

  const track = (ref: Hex | undefined) => {
    setTracked(ref)
    if (ref) setTab('payments')
  }

  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-4 px-4 pb-24 pt-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-xl" style={{ background: 'var(--accent)' }}>
            <ShieldCheck className="size-5 text-white" aria-hidden />
          </span>
          <div>
            <h1 className="display text-lg font-bold leading-tight">SplashProof Escrow</h1>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Arc Testnet {ESCROW_ADDRESS ? <>· <AddressChip address={ESCROW_ADDRESS} /></> : null}
            </p>
          </div>
        </div>
        <ConnectKitButton />
      </header>

      {!ESCROW_ADDRESS ? (
        <Notice tone="info">
          No escrow contract is connected yet. Screens are read-only until the contract is deployed and its address is set as
          VITE_ESCROW_ADDRESS.
        </Notice>
      ) : null}

      <nav className="grid grid-cols-3 gap-1 rounded-2xl p-1" style={{ background: 'var(--surface-muted)' }} role="tablist" aria-label="Screens">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className="min-h-11 rounded-xl text-sm font-semibold transition-colors focus-visible:outline-2"
            style={{
              background: tab === t.id ? 'var(--surface-strong)' : 'transparent',
              color: tab === t.id ? 'var(--ink)' : 'var(--muted)',
              boxShadow: tab === t.id ? '0 1px 4px rgba(18,45,69,0.12)' : undefined,
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'pay' ? <PayerScreen onTrack={track} /> : null}
        {tab === 'payments' ? <PaymentTimeline selected={tracked} onSelect={setTracked} /> : null}
        {tab === 'acknowledge' ? <BeneficiaryScreen onTrack={track} /> : null}
      </main>
    </div>
  )
}
