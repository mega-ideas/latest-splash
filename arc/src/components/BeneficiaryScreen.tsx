import { useEffect, useMemo, useState } from 'react'
import { useAccount, useReadContracts } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { ConnectKitButton } from 'connectkit'
import type { Hex } from 'viem'
import { Check } from 'lucide-react'
import { formatUsdc } from '@/onchain-money'
import {
  ARC_CHAIN_ID,
  ESCROW_ADDRESS,
  PaymentStatus,
  describeError,
  escrowAbi,
  isBytes32,
  shortHex,
  toBytes32,
  toPayment,
  type PaymentTuple,
} from '@/lib/escrow'
import { useEscrowWrite } from '@/hooks/useEscrowWrite'
import { useChainTime, useOpenedPayments, usePayment } from '@/hooks/useEscrowData'
import { AddressChip, Field, Notice, Row, Spinner, StatusPill, TxLink, formatCountdown, formatTime } from './ui'

export function BeneficiaryScreen({ onTrack }: { onTrack: (ref: Hex) => void }) {
  const { address, isConnected } = useAccount()
  const queryClient = useQueryClient()
  const ackTx = useEscrowWrite()
  const chainTime = useChainTime()

  const [refInput, setRefInput] = useState('')
  const [commitmentText, setCommitmentText] = useState('')
  const [ackText, setAckText] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const paymentRef = isBytes32(refInput) ? refInput : undefined
  const { payment, isLoading, refetch } = usePayment(paymentRef)
  const commitment = toBytes32(commitmentText)
  const ackHash = toBytes32(ackText)

  const opened = useOpenedPayments(undefined, Boolean(address))
  const candidates = useMemo(
    () =>
      (opened.data?.items ?? []).filter(
        (p) => !p.remoteAck && address !== undefined && p.beneficiaryVasp.toLowerCase() === address.toLowerCase(),
      ),
    [opened.data, address],
  )
  const statuses = useReadContracts({
    contracts: candidates.map((p) => ({
      address: ESCROW_ADDRESS,
      abi: escrowAbi,
      functionName: 'payments' as const,
      args: [p.paymentRef] as const,
      chainId: ARC_CHAIN_ID,
    })),
    query: { enabled: Boolean(ESCROW_ADDRESS) && candidates.length > 0, refetchInterval: 10000 },
  })
  const awaiting = candidates.filter((p, i) => {
    const result = statuses.data?.[i]?.result
    return result ? toPayment(result as unknown as PaymentTuple).status === PaymentStatus.Open : false
  })

  useEffect(() => {
    if (ackTx.isSuccess) {
      void refetch()
      void queryClient.invalidateQueries({ queryKey: ['escrow'] })
    }
  }, [ackTx.isSuccess, refetch, queryClient])

  const expired = payment && chainTime !== undefined ? chainTime >= payment.expiry : false
  const isVasp = Boolean(payment && address && payment.beneficiaryVasp.toLowerCase() === address.toLowerCase())

  const blocker = (() => {
    if (!paymentRef) return 'Enter or pick a payment reference.'
    if (!payment || isLoading) return undefined
    if (payment.status === PaymentStatus.None) return 'No payment with this reference exists.'
    if (payment.status !== PaymentStatus.Open) return 'This payment is already settled.'
    if (payment.remoteAck) return 'This payment is acknowledged through a CCIP message, not from this screen.'
    if (expired) return 'This payment has expired. The payer can now be refunded.'
    if (address && !isVasp) return 'Connect the beneficiary VASP wallet named on this payment.'
    if (!commitment) return 'Enter the travel rule commitment.'
    if (commitment !== payment.commitment) return 'This commitment does not match the payment.'
    if (!ackHash) return 'Add an acknowledgement reference.'
    return undefined
  })()

  const run = async () => {
    if (!ESCROW_ADDRESS || !paymentRef || !commitment || !ackHash) return
    setActionError(null)
    try {
      await ackTx.ensureChain()
      await ackTx.writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'ackLocal',
        args: [paymentRef, commitment, ackHash],
        chainId: ARC_CHAIN_ID,
      })
    } catch (e) {
      setActionError(describeError(e))
    }
  }

  const busy = ackTx.isPending || ackTx.isConfirming || ackTx.isSwitching
  const error = actionError ?? describeError(ackTx.error)

  if (ackTx.isSuccess && ackTx.hash && paymentRef) {
    return (
      <section className="card space-y-4">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full" style={{ background: 'rgba(26,128,71,0.12)' }}>
            <Check className="size-4" style={{ color: 'var(--success)' }} aria-hidden />
          </span>
          <h2 className="display text-xl font-bold">Payment acknowledged</h2>
        </div>
        <p className="text-sm text-pretty" style={{ color: 'var(--muted)' }}>
          The escrow released the funds to the recipient and took its fee.
        </p>
        <TxLink hash={ackTx.hash} />
        <button className="btn btn-primary" onClick={() => onTrack(paymentRef)}>View payment timeline</button>
        <button
          className="btn btn-ghost w-full"
          onClick={() => {
            ackTx.reset()
            setRefInput('')
            setCommitmentText('')
            setAckText('')
          }}
        >
          Acknowledge another
        </button>
      </section>
    )
  }

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="display text-2xl font-bold text-balance">Acknowledge a payment</h2>
        <p className="mt-1 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
          Confirm on Arc that your customer received the payment. Only the beneficiary VASP wallet can do this.
        </p>
      </div>

      {address ? (
        <div>
          <span className="eyebrow">Waiting for you</span>
          {opened.isLoading || statuses.isLoading ? (
            <div className="mt-2"><Spinner label="Looking for payments…" /></div>
          ) : awaiting.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {awaiting.map((p) => (
                <li key={p.paymentRef}>
                  <button
                    className="inner flex min-h-11 w-full items-center justify-between gap-3 text-left"
                    style={{ borderColor: refInput === p.paymentRef ? 'var(--border-strong)' : undefined }}
                    onClick={() => setRefInput(p.paymentRef)}
                  >
                    <span className="mono text-xs">{shortHex(p.paymentRef, 10, 6)}</span>
                    <span className="text-sm font-semibold tabular-nums">{formatUsdc(p.amount)} USDC</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
              No open local payments for this wallet in the recent history. You can still enter a reference below.
            </p>
          )}
        </div>
      ) : null}

      <Field label="Payment reference">
        <input className="input mono" placeholder="0x…" value={refInput} onChange={(e) => setRefInput(e.target.value.trim())} spellCheck={false} />
      </Field>

      {payment && payment.status !== PaymentStatus.None ? (
        <div className="inner">
          <div className="flex items-center justify-between pb-1">
            <span className="display text-xl font-bold tabular-nums">{formatUsdc(payment.amount)} USDC</span>
            <StatusPill status={payment.status} />
          </div>
          <Row label="Recipient"><AddressChip address={payment.recipient} /></Row>
          <Row label="Payer"><AddressChip address={payment.payer} /></Row>
          <Row label="Expires">{formatTime(payment.expiry)}</Row>
          {payment.status === PaymentStatus.Open && !expired && chainTime !== undefined ? (
            <Row label="Time left">{formatCountdown(payment.expiry - chainTime)}</Row>
          ) : null}
        </div>
      ) : null}

      <Field label="Travel rule commitment" hint="Enter the commitment you hold for this transfer. It must match what the payer locked.">
        <input className="input mono" placeholder="0x… or text" value={commitmentText} onChange={(e) => setCommitmentText(e.target.value)} spellCheck={false} />
      </Field>
      <Field label="Acknowledgement reference" hint="Your own reference for this confirmation, recorded onchain. A 32-byte hash is used as is, text is hashed.">
        <input className="input mono" placeholder="0x… or text" value={ackText} onChange={(e) => setAckText(e.target.value)} spellCheck={false} />
      </Field>

      {!isConnected ? (
        <ConnectKitButton.Custom>
          {({ show }) => <button className="btn btn-primary" onClick={show}>Connect VASP wallet</button>}
        </ConnectKitButton.Custom>
      ) : ackTx.wrongChain ? (
        <button className="btn btn-primary" onClick={() => void ackTx.ensureChain()}>Switch to Arc Testnet</button>
      ) : (
        <button className="btn btn-primary" disabled={Boolean(blocker) || !ESCROW_ADDRESS || busy} onClick={() => void run()}>
          {ackTx.isPending ? <Spinner label="Confirm in wallet…" /> : ackTx.isConfirming ? <Spinner label="Confirming…" /> : 'Acknowledge and release funds'}
        </button>
      )}

      {isConnected && blocker ? <p className="text-xs text-pretty" style={{ color: 'var(--muted)' }}>{blocker}</p> : null}
      {!ESCROW_ADDRESS ? <Notice tone="info">The escrow contract address is not configured yet.</Notice> : null}
      {ackTx.reverted ? <Notice tone="error">The acknowledgement was reverted onchain. Nothing moved.</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </section>
  )
}
