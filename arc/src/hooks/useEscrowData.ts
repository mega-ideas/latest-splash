import { useQuery } from '@tanstack/react-query'
import { useBlock, useReadContract } from 'wagmi'
import { decodeEventLog, getAbiItem, pad, toEventSelector, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import {
  ARC_CHAIN_ID,
  DEPLOY_BLOCK,
  ESCROW_ADDRESS,
  LOG_CHUNK,
  LOOKBACK_BLOCKS,
  escrowAbi,
  toPayment,
  type PaymentView,
} from '@/lib/escrow'

const OPENED_TOPIC = toEventSelector(getAbiItem({ abi: escrowAbi, name: 'PaymentOpened' }))

export type TimelineKind = 'opened' | 'rejected' | 'released' | 'refunded'

export interface TimelineEvent {
  kind: TimelineKind
  txHash: Hex
  blockNumber: bigint
  logIndex: number
  timestamp?: bigint
  messageId?: Hex
  reason?: number
  amount?: bigint
  net?: bigint
  fee?: bigint
}

export interface OpenedPayment {
  paymentRef: Hex
  payer: Address
  recipient: Address
  beneficiaryVasp: Address
  amount: bigint
  expiry: bigint
  remoteAck: boolean
  txHash: Hex
  blockNumber: bigint
}

export interface ScanWindow {
  fromBlock: bigint
  head: bigint
  /** True when the window starts at the deployment block, so history is complete. */
  complete: boolean
}

async function scanWindow(client: PublicClient): Promise<ScanWindow> {
  const head = await client.getBlockNumber()
  if (DEPLOY_BLOCK !== undefined) return { fromBlock: DEPLOY_BLOCK, head, complete: true }
  return { fromBlock: head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n, head, complete: false }
}

/** Current chain time, refreshed while a screen is mounted. */
export function useChainTime() {
  const { data } = useBlock({ chainId: ARC_CHAIN_ID, query: { refetchInterval: 4000 } })
  return data?.timestamp
}

export function usePayment(paymentRef: Hex | undefined) {
  const query = useReadContract({
    address: ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: 'payments',
    args: paymentRef ? [paymentRef] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: Boolean(ESCROW_ADDRESS && paymentRef), refetchInterval: 8000 },
  })
  const payment: PaymentView | undefined = query.data ? toPayment(query.data) : undefined
  return { ...query, payment }
}

export function useFeeBps() {
  const { data } = useReadContract({
    address: ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: 'feeBps',
    chainId: ARC_CHAIN_ID,
    query: { enabled: Boolean(ESCROW_ADDRESS) },
  })
  return data
}

/** Every escrow event for one payment reference, oldest first, with block timestamps. */
export function usePaymentEvents(paymentRef: Hex | undefined) {
  const client = usePublicClient({ chainId: ARC_CHAIN_ID })
  return useQuery({
    queryKey: ['escrow', 'events', paymentRef],
    enabled: Boolean(client && ESCROW_ADDRESS && paymentRef),
    refetchInterval: 8000,
    queryFn: async () => {
      if (!client || !ESCROW_ADDRESS || !paymentRef) throw new Error('not ready')
      const window = await scanWindow(client)
      const events: TimelineEvent[] = []
      for (let start = window.fromBlock; start <= window.head; start += LOG_CHUNK) {
        const end = start + LOG_CHUNK - 1n > window.head ? window.head : start + LOG_CHUNK - 1n
        // All four escrow events index paymentRef as their first topic.
        const logs = await client.request({
          method: 'eth_getLogs',
          params: [{ address: ESCROW_ADDRESS, fromBlock: toHex(start), toBlock: toHex(end), topics: [null, paymentRef] }],
        })
        for (const log of logs) {
          if (!log.blockNumber || !log.transactionHash || !log.logIndex) continue
          let decoded
          try {
            decoded = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics })
          } catch {
            continue
          }
          const base = {
            txHash: log.transactionHash,
            blockNumber: BigInt(log.blockNumber),
            logIndex: Number(BigInt(log.logIndex)),
          }
          if (decoded.eventName === 'PaymentOpened') events.push({ kind: 'opened', ...base, amount: decoded.args.amount })
          else if (decoded.eventName === 'AckRejected')
            events.push({ kind: 'rejected', ...base, messageId: decoded.args.messageId, reason: decoded.args.reason })
          else if (decoded.eventName === 'Released')
            events.push({
              kind: 'released',
              ...base,
              messageId: decoded.args.messageId,
              net: decoded.args.net,
              fee: decoded.args.fee,
            })
          else if (decoded.eventName === 'Refunded') events.push({ kind: 'refunded', ...base, amount: decoded.args.amount })
        }
      }
      const blockNumbers = [...new Set(events.map((e) => e.blockNumber))]
      const stamps = new Map<bigint, bigint>()
      await Promise.all(
        blockNumbers.map(async (blockNumber) => {
          const block = await client.getBlock({ blockNumber })
          stamps.set(blockNumber, block.timestamp)
        }),
      )
      events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
      return { events: events.map((e) => ({ ...e, timestamp: stamps.get(e.blockNumber) })), window }
    },
  })
}

/** Recent PaymentOpened events, optionally only those opened by one payer. */
export function useOpenedPayments(payer?: Address, enabled = true) {
  const client = usePublicClient({ chainId: ARC_CHAIN_ID })
  return useQuery({
    queryKey: ['escrow', 'opened', payer ?? 'all'],
    enabled: Boolean(client && ESCROW_ADDRESS && enabled),
    refetchInterval: 12000,
    queryFn: async () => {
      if (!client || !ESCROW_ADDRESS) throw new Error('not ready')
      const window = await scanWindow(client)
      const items: OpenedPayment[] = []
      const payerTopic = payer ? pad(payer, { size: 32 }) : null
      for (let start = window.fromBlock; start <= window.head; start += LOG_CHUNK) {
        const end = start + LOG_CHUNK - 1n > window.head ? window.head : start + LOG_CHUNK - 1n
        const logs = await client.request({
          method: 'eth_getLogs',
          params: [{ address: ESCROW_ADDRESS, fromBlock: toHex(start), toBlock: toHex(end), topics: [OPENED_TOPIC, null, payerTopic] }],
        })
        for (const log of logs) {
          if (!log.blockNumber || !log.transactionHash) continue
          let decoded
          try {
            decoded = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics })
          } catch {
            continue
          }
          if (decoded.eventName !== 'PaymentOpened') continue
          items.push({
            paymentRef: decoded.args.paymentRef,
            payer: decoded.args.payer,
            recipient: decoded.args.recipient,
            beneficiaryVasp: decoded.args.beneficiaryVasp,
            amount: decoded.args.amount,
            expiry: decoded.args.expiry,
            remoteAck: decoded.args.remoteAck,
            txHash: log.transactionHash,
            blockNumber: BigInt(log.blockNumber),
          })
        }
      }
      items.sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1))
      return { items, window }
    },
  })
}
