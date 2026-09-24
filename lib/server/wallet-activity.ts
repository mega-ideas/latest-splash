import { shortAddress, SUI_USDC_COIN_TYPE } from '../payments/stablecoin-lane.ts';

/**
 * A wallet's USDC activity, read from chain: what came in and what went out.
 *
 * The Splash wallet is meant to work like a wallet, and a wallet shows money
 * arriving, not only the transfers Splash itself sent. Splash's own records
 * (stablecoin_outflows) know nothing about a deposit from Slush or an
 * exchange, so this reads the chain: Sui GraphQL (mainnet), the transactions
 * that touched the address, keeping the ones that changed its USDC balance.
 * Read-only.
 *
 * Each movement is then labelled against Splash's records: a send Splash made
 * is named ("to Manila Parts Supply"), a deposit from a saved recipient is
 * named, and an outgoing movement with no Splash record is flagged — from a
 * passkey wallet only Splash can sign, so that one deserves a look.
 */

const DEFAULT_GRAPHQL = 'https://graphql.mainnet.sui.io/graphql';
const PAGE = 25;
const MAX_PAGES = 4;
const TIMEOUT_MS = 8_000;

const USDC = SUI_USDC_COIN_TYPE.mainnet;

export type ChainMovement = {
  digest: string;
  timestamp: string | null;
  success: boolean;
  direction: 'IN' | 'OUT';
  /** Absolute USDC amount, 6 dp minor units. */
  amountMinor: bigint;
  /** The other side of the movement when the chain shows one: the largest
   *  opposite USDC change by another owner. null for pools and the like. */
  counterparty: string | null;
};

export type ActivityPage =
  | { available: true; movements: ChainMovement[]; olderCursor: string | null }
  | { available: false; reason: string };

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const QUERY = `query WalletUsdcActivity($a: SuiAddress!, $last: Int!, $before: String) {
  address(address: $a) {
    transactions(last: $last, before: $before, relation: AFFECTED) {
      pageInfo { hasPreviousPage startCursor }
      nodes {
        digest
        effects {
          status
          timestamp
          balanceChanges { nodes { owner { address } amount coinType { repr } } }
        }
      }
    }
  }
}`;

type Node = {
  digest: string;
  effects?: {
    status?: string;
    timestamp?: string | null;
    balanceChanges?: { nodes?: Array<{ owner?: { address?: string } | null; amount?: string; coinType?: { repr?: string } | null }> };
  } | null;
};

function norm(address: string): string {
  return address.toLowerCase();
}

/** One transaction's effect on `address`'s USDC, or null if it did not move any. */
export function movementFor(address: string, node: Node): ChainMovement | null {
  const me = norm(address);
  const changes = (node.effects?.balanceChanges?.nodes ?? [])
    .filter((c) => c.coinType?.repr === USDC && c.owner?.address && /^-?\d+$/.test(c.amount ?? ''))
    .map((c) => ({ owner: norm(c.owner!.address!), amount: BigInt(c.amount!) }));
  const mine = changes.filter((c) => c.owner === me).reduce((sum, c) => sum + c.amount, 0n);
  if (mine === 0n) return null;
  const direction = mine > 0n ? 'IN' : 'OUT';
  // The counterparty moved the other way; the biggest such move is the payer
  // (for money in) or the payee (for money out — ahead of a fee leg).
  const opposite = changes
    .filter((c) => c.owner !== me && (direction === 'IN' ? c.amount < 0n : c.amount > 0n))
    .sort((a, b) => {
      const x = a.amount < 0n ? -a.amount : a.amount;
      const y = b.amount < 0n ? -b.amount : b.amount;
      return x === y ? 0 : x > y ? -1 : 1;
    });
  return {
    digest: node.digest,
    timestamp: node.effects?.timestamp ?? null,
    success: node.effects?.status === 'SUCCESS',
    direction,
    amountMinor: mine < 0n ? -mine : mine,
    counterparty: opposite[0]?.owner ?? null,
  };
}

/**
 * Up to `limit` USDC movements for `address`, newest first. Pages back through
 * the address's transactions (most carry no USDC — gas, other coins) until it
 * has enough or has looked at MAX_PAGES pages; `olderCursor` continues from
 * where it stopped.
 */
export async function readUsdcActivity(
  address: string,
  opts: { limit?: number; before?: string | null; fetcher?: Fetcher; endpoint?: string } = {},
): Promise<ActivityPage> {
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  const fetcher = opts.fetcher ?? fetch;
  const endpoint = opts.endpoint ?? DEFAULT_GRAPHQL;
  const movements: ChainMovement[] = [];
  let before: string | null = opts.before ?? null;
  let more = true;

  for (let page = 0; page < MAX_PAGES && more && movements.length < limit; page += 1) {
    let body: { data?: { address?: { transactions?: { pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null }; nodes?: Node[] } } | null }; errors?: Array<{ message?: string }> };
    try {
      const res = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { a: address, last: PAGE, before } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
      if (!res.ok) return { available: false, reason: `The Sui indexer answered HTTP ${res.status}.` };
      body = await res.json();
    } catch (error) {
      return { available: false, reason: `The Sui indexer did not answer: ${error instanceof Error ? error.message : 'unknown error'}.` };
    }
    if (body.errors?.length) return { available: false, reason: `The Sui indexer refused the query: ${body.errors[0]?.message ?? 'unknown error'}.` };
    const tx = body.data?.address?.transactions;
    if (!tx) break;
    // `last` returns the page oldest-first; walk it newest-first.
    for (const node of [...(tx.nodes ?? [])].reverse()) {
      const movement = movementFor(address, node);
      if (movement) movements.push(movement);
    }
    more = Boolean(tx.pageInfo?.hasPreviousPage);
    before = tx.pageInfo?.startCursor ?? null;
  }

  return { available: true, movements: movements.slice(0, limit), olderCursor: more ? before : null };
}

export type LabelledMovement = ChainMovement & {
  label: string;
  /**
   * SPLASH: sent through Splash (a matching record). RECEIVED: money in.
   * SENT: sent from a connected wallet outside Splash — normal for Slush or
   * MetaMask. NO_RECORD: sent from the Splash wallet with no Splash record,
   * which only Splash can sign for, so it is worth a look.
   */
  origin: 'SPLASH' | 'RECEIVED' | 'SENT' | 'NO_RECORD';
  feeMinor: bigint | null;
};

/**
 * Name each movement from Splash's own records. Pure: the caller loads the
 * outflows (by tx digest) and the org's wallet recipients (by address).
 * `splashWallet`: whether this is the passkey wallet, where every send should
 * have a Splash record.
 */
export function labelMovements(
  movements: ChainMovement[],
  outflowsByDigest: Map<string, { kind: string; recipientName: string | null; resource: string | null; feeMinor: bigint }>,
  recipientsByAddress: Map<string, string>,
  opts: { splashWallet: boolean; invoicesByDigest?: Map<string, { invoiceId: string; payerName: string | null }> } = { splashWallet: true },
): LabelledMovement[] {
  return movements.map((m) => {
    const outflow = outflowsByDigest.get(m.digest);
    const who = m.counterparty ? recipientsByAddress.get(norm(m.counterparty)) ?? null : null;
    if (m.direction === 'OUT' && outflow) {
      const label = outflow.kind === 'X402'
        ? `x402 payment${outflow.resource ? ` to ${hostOf(outflow.resource)}` : ''}`
        : `Sent with Splash to ${outflow.recipientName ?? who ?? (m.counterparty ? shortAddress(m.counterparty) : 'the recipient')}`;
      return { ...m, label, origin: 'SPLASH', feeMinor: outflow.kind === 'X402' ? null : outflow.feeMinor };
    }
    const invoice = m.direction === 'IN' ? opts.invoicesByDigest?.get(m.digest) : undefined;
    if (invoice) {
      const payer = invoice.payerName ?? who;
      return { ...m, label: `Invoice ${shortInvoiceId(invoice.invoiceId)} paid${payer ? ` by ${payer}` : ''}`, origin: 'RECEIVED', feeMinor: null };
    }
    if (m.direction === 'IN') {
      return { ...m, label: who ? `Received from ${who}` : m.counterparty ? `Received from ${shortAddress(m.counterparty)}` : 'Received', origin: 'RECEIVED', feeMinor: null };
    }
    const to = m.counterparty ? ` to ${who ?? shortAddress(m.counterparty)}` : '';
    return opts.splashWallet
      ? { ...m, label: `Sent with no Splash record${to}`, origin: 'NO_RECORD', feeMinor: null }
      : { ...m, label: `Sent${to}`, origin: 'SENT', feeMinor: null };
  });
}

/** Invoice ids are long; the tail is what people recognise. */
function shortInvoiceId(id: string): string {
  return id.length > 10 ? `…${id.slice(-6)}` : id;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
