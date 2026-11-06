import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { ConnectKitButton } from 'connectkit'
import { Check, CircleDot, Clock, RotateCcw, X } from 'lucide-react'
import type { Hex } from 'viem'
import { formatUsdc } from '@/onchain-money'
import {
  ARC_CHAIN_ID,
  ESCROW_ADDRESS,
  PaymentStatus,
  ZERO_BYTES32,
  ccipMessageUrl,
  describeError,
  escrowAbi,
  feeFor,
  isBytes32,
  rejectReason,
  shortHex,
} from '@/lib/escrow'
import { useEscrowWrite } from '@/hooks/useEscrowWrite'
import {
  useChainTime,
  useFeeBps,
  useOpenedPayments,
  usePayment,
  usePaymentEvents,
  type TimelineEvent,
} from '@/hooks/useEscrowData'
import { AddressChip, ExplorerLink, Notice, Row, Spinner, StatusPill, TxLink, formatCountdown, formatTime } from './ui'

function EventIcon({ kind }: { kind: TimelineEvent['kind'] }) {
  const common = { className: 'size-4', 'aria-hidden': true } as const
  if (kind === 'released') return <Check {...common} style={{ color: 'var(--success)' }} />
  if (kind === 'refunded') return <RotateCcw {...common} style={{ color: 'var(--accent-hover)' }} />
  if (kind === 'rejected') return <X {...common} style={{ color: 'var(--danger)' }} />
  return <CircleDot {...common} />
}

function eventTitle(e: TimelineEvent): string {
  if (e.kind === 'opened') return `Locked ${e.amount !== undefined ? formatUsdc(e.amount) : ''} USDC in escrow`
  if (e.kind === 'released') return `Released: ${formatUsdc(e.net ?? 0n)} to recipient, ${formatUsdc(e.fee ?? 0n)} fee`
  if (e.kind === 'refunded') return `Refunded ${formatUsdc(e.amount ?? 0n)} USDC to payer, no fee`
  return 'Acknowledgement rejected'
}

function Step({ event }: { event: TimelineEvent }) {
  const hasMessage = event.messageId !== undefined && event.messageId !== ZERO_BYTES32
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }}>
        <EventIcon kind={event.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-pretty">{eventTitle(event)}</p>
        {event.kind === 'rejected' && event.reason !== undefined ? (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>{rejectReason(event.reason)}</p>
        ) : null}
        <p className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
          {event.timestamp !== undefined ? formatTime(event.timestamp) : `Block ${event.blockNumber}`}
        </p>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          <TxLink hash={event.txHash} />
          {hasMessage && event.messageId ? (
            <ExplorerLink href={ccipMessageUrl(event.messageId)}>View on CCIP Explorer</ExplorerLink>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function TimelineCard({ paymentRef }: { paymentRef: Hex }) {
  const { isConnected } = useAccount()
  const queryClient = useQueryClient()
  const refundTx = useEscrowWrite()
  const { payment, isLoading: paymentLoading, refetch } = usePayment(paymentRef)
  const events = usePaymentEvents(paymentRef)
  const feeBps = useFeeBps()
  const chainTime = useChainTime()
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (refundTx.isSuccess) {
      void refetch()
      void queryClient.invalidateQueries({ queryKey: ['escrow'] })
    }
  }, [refundTx.isSuccess, refetch, queryClient])

  if (paymentLoading) return <section className="card"><Spinner label="Loading payment…" /></section>
  if (!payment || payment.status === PaymentStatus.None) {
    return (
      <section className="card">
        <Notice tone="info">No payment with this reference exists on this escrow.</Notice>
      </section>
    )
  }

  const isOpen = payment.status === PaymentStatus.Open
  const expired = chainTime !== undefined && chainTime >= payment.expiry
  const remaining = chainTime !== undefined ? payment.expiry - chainTime : undefined
  const maxFeeNow = feeBps !== undefined ? feeFor(payment.amount, payment.maxFee, feeBps) : undefined

  const runRefund = async () => {
    if (!ESCROW_ADDRESS) return
    setActionError(null)
    try {
      await refundTx.ensureChain()
      await refundTx.writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'refund',
        args: [paymentRef],
        chainId: ARC_CHAIN_ID,
      })
    } catch (e) {
      setActionError(describeError(e))
    }
  }

  const busy = refundTx.isPending || refundTx.isConfirming || refundTx.isSwitching
  const error = actionError ?? describeError(refundTx.error)
  const windowNote = events.data && !events.data.window.complete
    ? 'History covers the most recent blocks only. Set the deployment block to see everything.'
    : null

  return (
    <section className="card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="eyebrow">Payment</span>
          <p className="mono truncate text-xs" title={paymentRef}>{shortHex(paymentRef, 12, 8)}</p>
          <p className="display mt-1 text-3xl font-bold tabular-nums">
            {formatUsdc(payment.amount)} <span className="text-lg font-medium" style={{ color: 'var(--subtle)' }}>USDC</span>
          </p>
        </div>
        <StatusPill status={payment.status} />
      </div>

      <div className="inner">
        <Row label="Payer"><AddressChip address={payment.payer} /></Row>
        <Row label="Recipient"><AddressChip address={payment.recipient} /></Row>
        <Row label="Beneficiary VASP"><AddressChip address={payment.beneficiaryVasp} /></Row>
        <Row label="Acknowledged via">{payment.remoteAck ? 'CCIP message' : 'Local VASP wallet'}</Row>
        <Row label="Expires">{formatTime(payment.expiry)}</Row>
        {isOpen && maxFeeNow !== undefined ? <Row label="Fee if released">up to {formatUsdc(maxFeeNow)} USDC</Row> : null}
      </div>

      <div>
        <h3 className="eyebrow mb-3">Timeline</h3>
        {events.isLoading ? (
          <Spinner label="Reading events…" />
        ) : events.isError ? (
          <Notice tone="error">Could not read payment events. Retrying shortly.</Notice>
        ) : (
          <ol className="relative">
            {events.data?.events.map((e) => <Step key={`${e.txHash}-${e.logIndex}`} event={e} />)}
            {isOpen ? (
              <li className="flex gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed" style={{ borderColor: 'var(--border-strong)' }}>
                  <Clock className="size-4" aria-hidden />
                </span>
                <div>
                  <p className="text-sm font-semibold">
                    {expired ? 'Expired: refund is available' : 'Waiting for acknowledgement'}
                  </p>
                  <p className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
                    {expired ? 'Anyone can send the money back to the payer.' : remaining !== undefined ? `Refundable in ${formatCountdown(remaining)}` : ''}
                  </p>
                </div>
              </li>
            ) : null}
          </ol>
        )}
        {windowNote ? <p className="mt-3 text-xs" style={{ color: 'var(--subtle)' }}>{windowNote}</p> : null}
      </div>

      {isOpen ? (
        !isConnected ? (
          <ConnectKitButton.Custom>
            {({ show }) => <button className="btn btn-primary" onClick={show}>Connect wallet to refund</button>}
          </ConnectKitButton.Custom>
        ) : refundTx.wrongChain ? (
          <button className="btn btn-primary" onClick={() => void refundTx.ensureChain()}>Switch to Arc Testnet</button>
        ) : (
          <button className="btn btn-primary" disabled={!expired || busy} onClick={() => void runRefund()}>
            {refundTx.isPending ? <Spinner label="Confirm in wallet…" /> : refundTx.isConfirming ? <Spinner label="Confirming…" /> : expired ? `Refund ${formatUsdc(payment.amount)} USDC to payer` : 'Refund opens at expiry'}
          </button>
        )
      ) : null}

      {refundTx.isSuccess && refundTx.hash ? (
        <Notice tone="success">Refunded. <TxLink hash={refundTx.hash} /></Notice>
      ) : null}
      {refundTx.reverted ? <Notice tone="error">The refund was reverted onchain. Nothing moved.</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </section>
  )
}

export function PaymentTimeline({
  selected,
  onSelect,
}: {
  selected: Hex | undefined
  onSelect: (ref: Hex | undefined) => void
}) {
  const { address } = useAccount()
  const mine = useOpenedPayments(address, Boolean(address))
  const [lookup, setLookup] = useState('')

  return (
    <div className="space-y-4">
      <section className="card space-y-3">
        <h2 className="display text-2xl font-bold">Payments</h2>
        <div className="field inner flex items-center gap-2 py-0.5">
          <input
            className="input mono"
            placeholder="Look up by payment reference 0x…"
            value={lookup}
            onChange={(e) => {
              const v = e.target.value.trim()
              setLookup(v)
              if (isBytes32(v)) onSelect(v)
            }}
            spellCheck={false}
            aria-label="Payment reference"
          />
        </div>
        {lookup && !isBytes32(lookup) ? <p className="text-xs" style={{ color: 'var(--muted)' }}>A reference is 0x followed by 64 hex characters.</p> : null}

        {address ? (
          <div>
            <span className="eyebrow">Opened by you</span>
            {mine.isLoading ? (
              <div className="mt-2"><Spinner label="Reading your payments…" /></div>
            ) : mine.data && mine.data.items.length > 0 ? (
              <ul className="mt-2 space-y-2">
                {mine.data.items.map((p) => (
                  <li key={p.paymentRef}>
                    <button
                      className="inner flex min-h-11 w-full items-center justify-between gap-3 text-left"
                      style={{ borderColor: selected === p.paymentRef ? 'var(--border-strong)' : undefined }}
                      onClick={() => onSelect(p.paymentRef)}
                    >
                      <span className="mono text-xs">{shortHex(p.paymentRef, 10, 6)}</span>
                      <span className="text-sm font-semibold tabular-nums">{formatUsdc(p.amount)} USDC</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>No payments from this wallet yet.</p>
            )}
          </div>
        ) : null}
      </section>

      {selected ? <TimelineCard key={selected} paymentRef={selected} /> : null}
    </div>
  )
}
