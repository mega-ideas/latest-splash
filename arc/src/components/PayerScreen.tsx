import { useEffect, useMemo, useState } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { ConnectKitButton } from 'connectkit'
import { erc20Abi, isAddress, type Address, type Hex } from 'viem'
import { Check, Dices } from 'lucide-react'
import { TokenUSDC } from '@web3icons/react'
import { formatUsdc, parseUsdc } from '@/onchain-money'
import {
  ARC_CHAIN_ID,
  ESCROW_ADDRESS,
  PaymentStatus,
  USDC_ADDRESS,
  describeError,
  escrowAbi,
  feeFor,
  isBytes32,
  randomRef,
  shortHex,
  toBytes32,
  ZERO_BYTES32,
} from '@/lib/escrow'
import { useEscrowWrite } from '@/hooks/useEscrowWrite'
import { useFeeBps, usePayment } from '@/hooks/useEscrowData'
import { Field, Notice, Row, Spinner, TxLink } from './ui'

const DURATIONS = [
  { label: '15 min', seconds: 900 },
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
] as const

function tryParseUsdc(value: string): bigint | undefined {
  if (!value.trim()) return undefined
  try {
    return parseUsdc(value.trim())
  } catch {
    return undefined
  }
}

export function PayerScreen({ onTrack }: { onTrack: (ref: Hex) => void }) {
  const { address, isConnected } = useAccount()
  const queryClient = useQueryClient()
  const approveTx = useEscrowWrite()
  const openTx = useEscrowWrite()

  const [ref, setRef] = useState<Hex>(randomRef)
  const [recipient, setRecipient] = useState('')
  const [vasp, setVasp] = useState('')
  const [amount, setAmount] = useState('')
  const [feeCap, setFeeCap] = useState('')
  const [commitmentText, setCommitmentText] = useState('')
  const [duration, setDuration] = useState<number>(86400)
  const [remoteAck, setRemoteAck] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const amountRaw = tryParseUsdc(amount)
  const feeCapRaw = feeCap.trim() ? tryParseUsdc(feeCap) : amountRaw
  const commitment = toBytes32(commitmentText)
  const feeBps = useFeeBps()
  const existing = usePayment(isBytes32(ref) ? ref : undefined)

  const balance = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: Boolean(address), refetchInterval: 8000 },
  })
  const allowance = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && ESCROW_ADDRESS ? [address, ESCROW_ADDRESS] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: Boolean(address && ESCROW_ADDRESS), refetchInterval: 8000 },
  })

  const approved = amountRaw !== undefined && allowance.data !== undefined && allowance.data >= amountRaw

  const problem = useMemo(() => {
    if (!isBytes32(ref)) return 'The payment reference must be 32 bytes of hex.'
    if (existing.payment && existing.payment.status !== PaymentStatus.None) return 'That payment reference is already taken. Generate a new one.'
    if (!isAddress(recipient)) return 'Enter the recipient address.'
    if (!isAddress(vasp)) return 'Enter the beneficiary VASP address.'
    if (amountRaw === undefined || amountRaw === 0n) return 'Enter an amount greater than zero.'
    if (feeCapRaw === undefined) return 'The fee cap is not a valid amount.'
    if (feeCapRaw > amountRaw) return 'The fee cap cannot exceed the amount.'
    if (!commitment || commitment === ZERO_BYTES32) return 'Add the travel rule commitment.'
    if (balance.data !== undefined && balance.data < amountRaw) return 'Your USDC balance is below this amount.'
    return undefined
  }, [ref, existing.payment, recipient, vasp, amountRaw, feeCapRaw, commitment, balance.data])

  useEffect(() => {
    if (approveTx.isSuccess) void allowance.refetch()
  }, [approveTx.isSuccess, allowance])

  useEffect(() => {
    if (openTx.isSuccess) void queryClient.invalidateQueries({ queryKey: ['escrow'] })
  }, [openTx.isSuccess, queryClient])

  const runApprove = async () => {
    if (!ESCROW_ADDRESS || amountRaw === undefined) return
    setActionError(null)
    try {
      await approveTx.ensureChain()
      await approveTx.writeContractAsync({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'approve',
        args: [ESCROW_ADDRESS, amountRaw],
        chainId: ARC_CHAIN_ID,
      })
    } catch (e) {
      setActionError(describeError(e))
    }
  }

  const runOpen = async () => {
    if (!ESCROW_ADDRESS || amountRaw === undefined || feeCapRaw === undefined || !commitment) return
    setActionError(null)
    try {
      await openTx.ensureChain()
      await openTx.writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'open',
        args: [
          ref,
          recipient as Address,
          vasp as Address,
          amountRaw,
          feeCapRaw,
          commitment,
          BigInt(Math.floor(Date.now() / 1000) + duration),
          remoteAck,
        ],
        chainId: ARC_CHAIN_ID,
      })
    } catch (e) {
      setActionError(describeError(e))
    }
  }

  const startOver = () => {
    approveTx.reset()
    openTx.reset()
    setActionError(null)
    setRef(randomRef())
    setAmount('')
  }

  if (openTx.isSuccess && openTx.hash) {
    return (
      <section className="card space-y-4">
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full" style={{ background: 'rgba(26,128,71,0.12)' }}>
            <Check className="size-4" style={{ color: 'var(--success)' }} aria-hidden />
          </span>
          <h2 className="display text-xl font-bold">USDC locked in escrow</h2>
        </div>
        <div className="inner">
          <Row label="Reference">
            <span className="mono text-xs">{shortHex(ref, 10, 6)}</span>
          </Row>
          <Row label="Amount">{amountRaw !== undefined ? formatUsdc(amountRaw) : ''} USDC</Row>
        </div>
        <TxLink hash={openTx.hash} />
        <button className="btn btn-primary" onClick={() => onTrack(ref)}>Follow this payment</button>
        <button className="btn btn-ghost w-full" onClick={startOver}>Start another payment</button>
      </section>
    )
  }

  const fee = amountRaw !== undefined && feeCapRaw !== undefined && feeBps !== undefined ? feeFor(amountRaw, feeCapRaw, feeBps) : undefined
  const busyApprove = approveTx.isPending || approveTx.isConfirming || approveTx.isSwitching
  const busyOpen = openTx.isPending || openTx.isConfirming || openTx.isSwitching
  const txError = describeError(approveTx.error) ?? describeError(openTx.error)

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="display text-2xl font-bold text-balance">Lock a payment</h2>
        <p className="mt-1 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
          Your USDC stays in escrow until the beneficiary VASP acknowledges it, or comes back to you after expiry.
        </p>
      </div>

      <Field label="Amount">
        <TokenUSDC variant="branded" size={22} />
        <input
          className="input display text-2xl font-bold tabular-nums"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          aria-label="Amount in USDC"
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9.]/g, '')
            if (/^\d*\.?\d*$/.test(v)) setAmount(v)
          }}
        />
        <button
          type="button"
          className="shrink-0 text-xs font-semibold disabled:opacity-40"
          style={{ color: 'var(--accent-hover)' }}
          disabled={balance.data === undefined}
          onClick={() => balance.data !== undefined && setAmount(formatUsdc(balance.data))}
        >
          {balance.data !== undefined ? `Max ${formatUsdc(balance.data)}` : 'Balance n/a'}
        </button>
      </Field>

      <Field label="Recipient">
        <input className="input mono" placeholder="0x…" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} spellCheck={false} />
      </Field>
      <Field label="Beneficiary VASP" hint="The wallet allowed to acknowledge locally, and the VASP named in a CCIP acknowledgement.">
        <input className="input mono" placeholder="0x…" value={vasp} onChange={(e) => setVasp(e.target.value.trim())} spellCheck={false} />
      </Field>
      <Field label="Travel rule commitment" hint="Paste a 32-byte hash, or type your payload reference and it is hashed for you.">
        <input className="input mono" placeholder="0x… or text" value={commitmentText} onChange={(e) => setCommitmentText(e.target.value)} spellCheck={false} />
      </Field>
      <Field label="Fee cap (optional)" hint="The fee is charged only on release, at the contract's rate, never above this cap.">
        <input
          className="input tabular-nums"
          inputMode="decimal"
          placeholder="No cap"
          value={feeCap}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9.]/g, '')
            if (/^\d*\.?\d*$/.test(v)) setFeeCap(v)
          }}
        />
        <span className="text-xs" style={{ color: 'var(--subtle)' }}>USDC</span>
      </Field>
      <Field label="Payment reference">
        <input className="input mono" value={ref} onChange={(e) => setRef(e.target.value.trim() as Hex)} spellCheck={false} />
        <button type="button" className="rounded-lg p-2" aria-label="Generate a new reference" onClick={() => setRef(randomRef())}>
          <Dices className="size-4" aria-hidden />
        </button>
      </Field>

      <div>
        <span className="eyebrow">Refundable after</span>
        <div className="mt-1.5 grid grid-cols-4 gap-2" role="radiogroup" aria-label="Expiry">
          {DURATIONS.map((d) => (
            <button
              key={d.seconds}
              role="radio"
              aria-checked={duration === d.seconds}
              onClick={() => setDuration(d.seconds)}
              className="min-h-11 rounded-xl border text-xs font-semibold"
              style={{
                borderColor: duration === d.seconds ? 'var(--border-strong)' : 'var(--border)',
                background: duration === d.seconds ? 'var(--surface-strong)' : 'transparent',
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <label className="inner flex min-h-11 cursor-pointer items-center justify-between gap-3">
        <span className="text-sm">
          <span className="font-semibold">Acknowledge across chains (CCIP)</span>
          <span className="block text-xs" style={{ color: 'var(--muted)' }}>
            Off: the beneficiary VASP acknowledges on Arc from the Acknowledge tab.
          </span>
        </span>
        <input type="checkbox" className="size-5 shrink-0" checked={remoteAck} onChange={(e) => setRemoteAck(e.target.checked)} />
      </label>

      <div className="inner">
        <Row label="You lock">{amountRaw !== undefined ? formatUsdc(amountRaw) : '0.00'} USDC</Row>
        <Row label="Fee if released">{fee !== undefined ? `up to ${formatUsdc(fee)} USDC` : 'n/a'}</Row>
        <Row label="If never acknowledged">Full refund, no fee</Row>
      </div>

      {!ESCROW_ADDRESS ? (
        <Notice tone="info">The escrow contract address is not configured yet, so payments cannot be opened.</Notice>
      ) : null}

      <ol className="flex items-center gap-2 text-xs font-semibold" aria-label="Steps">
        <li className="flex items-center gap-1.5" style={{ color: approved ? 'var(--success)' : 'var(--ink)' }}>
          {approved ? <Check className="size-4" aria-hidden /> : <span className="mono">1</span>} Allow USDC
        </li>
        <li aria-hidden style={{ color: 'var(--subtle)' }}>›</li>
        <li className="flex items-center gap-1.5" style={{ color: approved ? 'var(--ink)' : 'var(--subtle)' }}>
          <span className="mono">2</span> Lock in escrow
        </li>
      </ol>

      {!isConnected ? (
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button className="btn btn-primary" onClick={show}>Connect wallet</button>
          )}
        </ConnectKitButton.Custom>
      ) : approveTx.wrongChain || openTx.wrongChain ? (
        <button className="btn btn-primary" onClick={() => void approveTx.ensureChain()}>Switch to Arc Testnet</button>
      ) : !approved ? (
        <button className="btn btn-primary" disabled={Boolean(problem) || !ESCROW_ADDRESS || busyApprove} onClick={() => void runApprove()}>
          {approveTx.isPending ? <Spinner label="Confirm in wallet…" /> : approveTx.isConfirming ? <Spinner label="Confirming…" /> : `Allow ${amountRaw ? formatUsdc(amountRaw) : ''} USDC`}
        </button>
      ) : (
        <button className="btn btn-primary" disabled={Boolean(problem) || !ESCROW_ADDRESS || busyOpen} onClick={() => void runOpen()}>
          {openTx.isPending ? <Spinner label="Confirm in wallet…" /> : openTx.isConfirming ? <Spinner label="Confirming…" /> : `Lock ${amountRaw ? formatUsdc(amountRaw) : ''} USDC`}
        </button>
      )}

      {isConnected && problem && (amount || recipient || vasp) ? (
        <p className="text-xs text-pretty" style={{ color: 'var(--muted)' }}>{problem}</p>
      ) : null}
      {actionError ?? txError ? <Notice tone="error">{actionError ?? txError}</Notice> : null}
      {approveTx.reverted || openTx.reverted ? <Notice tone="error">The transaction was reverted onchain. Nothing moved.</Notice> : null}
    </section>
  )
}
