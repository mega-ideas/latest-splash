import type { ReactNode } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { buildAddressExplorerUrl, buildTxExplorerUrl } from '@/onchain-facts'
import { ARC_CHAIN_ID, PaymentStatus, shortHex } from '@/lib/escrow'

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <div className="field inner mt-1.5 flex items-center gap-2 py-0.5">{children}</div>
      {hint ? <p className="mt-1.5 text-xs text-pretty" style={{ color: 'var(--subtle)' }}>{hint}</p> : null}
    </label>
  )
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="flex items-center justify-center gap-2">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </span>
  )
}

export function ExplorerLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-6 items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline"
      style={{ color: 'var(--accent-hover)' }}
    >
      {children}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  )
}

export function TxLink({ hash, label = 'View on Arc explorer' }: { hash: string; label?: string }) {
  return <ExplorerLink href={buildTxExplorerUrl(ARC_CHAIN_ID, hash)}>{label}</ExplorerLink>
}

export function AddressChip({ address }: { address: string }) {
  return (
    <a
      href={buildAddressExplorerUrl(ARC_CHAIN_ID, address)}
      target="_blank"
      rel="noopener noreferrer"
      className="mono text-xs tabular-nums underline-offset-2 hover:underline"
      title={address}
    >
      {shortHex(address)}
    </a>
  )
}

const STATUS_STYLE: Record<PaymentStatus, { label: string; color: string; bg: string }> = {
  [PaymentStatus.None]: { label: 'Not found', color: 'var(--muted)', bg: 'rgba(107,101,128,0.12)' },
  [PaymentStatus.Open]: { label: 'Open', color: 'var(--warn)', bg: 'rgba(154,98,0,0.12)' },
  [PaymentStatus.Released]: { label: 'Released', color: 'var(--success)', bg: 'rgba(26,128,71,0.12)' },
  [PaymentStatus.Refunded]: { label: 'Refunded', color: 'var(--accent-hover)', bg: 'rgba(16,97,166,0.12)' },
}

export function StatusPill({ status }: { status: PaymentStatus }) {
  const s = STATUS_STYLE[status]
  return (
    <span
      className="rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ color: s.color, background: s.bg }}
    >
      {s.label}
    </span>
  )
}

export function Notice({ tone, children }: { tone: 'info' | 'error' | 'success'; children: ReactNode }) {
  const color = tone === 'error' ? 'var(--danger)' : tone === 'success' ? 'var(--success)' : 'var(--ink-2)'
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className="inner text-sm text-pretty"
      style={{ color, borderColor: tone === 'info' ? undefined : color }}
    >
      {children}
    </div>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="text-right font-medium tabular-nums">{children}</span>
    </div>
  )
}

export function formatTime(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatCountdown(seconds: bigint): string {
  let s = Number(seconds)
  if (s <= 0) return 'now'
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${s - m * 60}s`
}
