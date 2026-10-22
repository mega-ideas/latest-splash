/**
 * The operator outflow monitor's I/O half (WS4). The decision is
 * lib/server/operator-outflows.ts, which is pure and tested; this file only
 * gathers its inputs and delivers its alerts.
 *
 *   - the operator address: OPERATOR_SUI_ADDRESS (the contract config). The
 *     monitor never builds a signer and never touches the key;
 *   - its recent transactions: Sui GraphQL, the ones the address SENT —
 *     only the operator can spend coins the operator owns, so a transaction
 *     somebody else sent cannot be an outflow from it;
 *   - the allowlist: approved wallet beneficiaries from the recipients store;
 *   - our core package ids: SPLASH_CORE_PACKAGE_ID and the legacy
 *     SPLASH_PACKAGE_ID alias.
 *
 * It looks back `sinceMs` (default two hours) over at most MAX_PAGES pages.
 * Alerts are de-duplicated within one process; a fresh process re-alerts on
 * a digest still inside the window, which is the safe direction, and the
 * alert carries the digest so the receiver can de-duplicate across runs.
 */
import { getContractConfig } from './contract-config.ts';
import { sendOperatorAlert, type OperatorAlertSink } from './operator-alerts.ts';
import {
  classifyOperatorTransactions,
  normalizeSuiAddress,
  type OperatorTransaction,
  type OutflowReport,
} from './operator-outflows.ts';

const PAGE = 25;
const MAX_PAGES = 4;
const TIMEOUT_MS = 8_000;
const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type OperatorTransactionReader = (operator: string, sinceMs: number) => Promise<OperatorTransaction[]>;

export type MonitorResult =
  | { ok: true; operator: string; scanned: number; report: OutflowReport; alerted: string[] }
  | { ok: false; reason: string };

const QUERY = `query OperatorSent($a: SuiAddress!, $last: Int!, $before: String) {
  address(address: $a) {
    transactions(last: $last, before: $before, relation: SENT) {
      pageInfo { hasPreviousPage startCursor }
      nodes {
        digest
        sender { address }
        kind {
          __typename
          ... on ProgrammableTransaction {
            commands(first: 100) {
              nodes {
                __typename
                ... on MoveCallCommand { function { name module { name package { address } } } }
              }
            }
          }
        }
        effects {
          status
          timestamp
          gasEffects { gasSummary { computationCost storageCost storageRebate } }
          balanceChanges(first: 100) { nodes { owner { address } amount coinType { repr } } }
        }
      }
    }
  }
}`;

type GqlNode = {
  digest: string;
  sender?: { address?: string } | null;
  kind?: {
    __typename?: string;
    commands?: { nodes?: Array<{ __typename?: string; function?: { name?: string; module?: { name?: string; package?: { address?: string } } } }> };
  } | null;
  effects?: {
    status?: string;
    timestamp?: string | null;
    gasEffects?: { gasSummary?: { computationCost?: string; storageCost?: string; storageRebate?: string } } | null;
    balanceChanges?: { nodes?: Array<{ owner?: { address?: string } | null; amount?: string; coinType?: { repr?: string } | null }> };
  } | null;
};

const INTEGER = /^-?\d+$/;
const big = (v: string | undefined) => (v && INTEGER.test(v) ? BigInt(v) : 0n);

/** One GraphQL node as the classifier's input. Exported for the cron's
 *  own diagnostics; the classifier is what the tests exercise. */
export function toOperatorTransaction(node: GqlNode): OperatorTransaction {
  const gas = node.effects?.gasEffects?.gasSummary;
  const timestamp = node.effects?.timestamp ? Date.parse(node.effects.timestamp) : NaN;
  return {
    digest: node.digest,
    timestampMs: Number.isFinite(timestamp) ? timestamp : null,
    gasMist: big(gas?.computationCost) + big(gas?.storageCost) - big(gas?.storageRebate),
    moveCalls: (node.kind?.commands?.nodes ?? [])
      .filter((c) => c.__typename === 'MoveCallCommand' && c.function?.module?.package?.address)
      .map((c) => ({
        package: c.function!.module!.package!.address!,
        module: c.function!.module!.name ?? '',
        function: c.function!.name ?? '',
      })),
    balanceChanges: (node.effects?.balanceChanges?.nodes ?? [])
      .filter((c) => c.coinType?.repr && INTEGER.test(c.amount ?? ''))
      .map((c) => ({ owner: c.owner?.address ?? null, coinType: c.coinType!.repr!, amount: BigInt(c.amount!) })),
  };
}

function defaultEndpoint(): string {
  const configured = process.env.SUI_GRAPHQL_URL?.trim();
  if (configured) return configured;
  return process.env.SUI_NETWORK === 'mainnet' ? 'https://graphql.mainnet.sui.io/graphql' : 'https://graphql.testnet.sui.io/graphql';
}

export function graphqlOperatorReader(fetcher: Fetcher = fetch, endpoint = defaultEndpoint()): OperatorTransactionReader {
  return async (operator, sinceMs) => {
    const out: OperatorTransaction[] = [];
    let before: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { a: operator, last: PAGE, before } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`the Sui indexer answered HTTP ${res.status}`);
      const body = (await res.json()) as {
        data?: { address?: { transactions?: { pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null }; nodes?: GqlNode[] } } | null };
        errors?: Array<{ message?: string }>;
      };
      if (body.errors?.length) throw new Error(`the Sui indexer refused the query: ${body.errors[0]?.message ?? 'unknown error'}`);
      const tx = body.data?.address?.transactions;
      if (!tx) break;
      let reachedWindowStart = false;
      // `last` returns the page oldest-first; walk it newest-first.
      for (const node of [...(tx.nodes ?? [])].reverse()) {
        // Belt and braces over `relation: SENT`.
        if (node.sender?.address && normalizeSuiAddress(node.sender.address) !== normalizeSuiAddress(operator)) continue;
        // A failed transaction moved nothing but gas.
        if (node.effects?.status && node.effects.status !== 'SUCCESS') continue;
        const parsed = toOperatorTransaction(node);
        if (parsed.timestampMs != null && parsed.timestampMs < sinceMs) {
          reachedWindowStart = true;
          break;
        }
        out.push(parsed);
      }
      if (reachedWindowStart || !tx.pageInfo?.hasPreviousPage) break;
      before = tx.pageInfo?.startCursor ?? null;
      if (!before) break;
    }
    return out;
  };
}

const alertedDigests = new Set<string>();

export async function runOperatorOutflowMonitor(deps: {
  now?: number;
  windowMs?: number;
  readTransactions?: OperatorTransactionReader;
  readAllowlist?: () => Promise<string[]>;
  alert?: OperatorAlertSink;
} = {}): Promise<MonitorResult> {
  const cfg = getContractConfig();
  const operatorRaw = (cfg.operatorAddress ?? '').trim();
  if (!operatorRaw) return { ok: false, reason: 'OPERATOR_SUI_ADDRESS is not configured, so there is no operator address to watch.' };
  const operator = normalizeSuiAddress(operatorRaw);
  const corePackageIds = [cfg.corePackageId, cfg.packageId].map((id) => (id ?? '').trim()).filter(Boolean);

  const readTransactions = deps.readTransactions ?? graphqlOperatorReader();
  const readAllowlist = deps.readAllowlist ?? (async () => {
    const { listApprovedWalletAddressesForStaff } = await import('./recipients-store.ts');
    return listApprovedWalletAddressesForStaff();
  });
  const alert = deps.alert ?? sendOperatorAlert;
  const sinceMs = (deps.now ?? Date.now()) - (deps.windowMs ?? DEFAULT_WINDOW_MS);

  let transactions: OperatorTransaction[];
  let allowlist: string[];
  try {
    [transactions, allowlist] = await Promise.all([readTransactions(operator, sinceMs), readAllowlist()]);
  } catch (error) {
    return { ok: false, reason: `the monitor could not read its inputs: ${error instanceof Error ? error.message : String(error)}` };
  }

  const report = classifyOperatorTransactions(transactions, {
    operator,
    corePackageIds,
    approvedRecipients: new Set(allowlist),
  });

  const alerted: string[] = [];
  for (const flagged of report.flagged) {
    if (alertedDigests.has(flagged.digest)) continue;
    alertedDigests.add(flagged.digest);
    if (alertedDigests.size > 5_000) alertedDigests.delete(alertedDigests.values().next().value as string);
    await alert({
      kind: 'operator_unapproved_outflow',
      severity: 'critical',
      operator,
      digest: flagged.digest,
      reason: flagged.reason,
      detail: { recipients: flagged.recipients, operatorOutflow: flagged.operatorOutflow, timestampMs: flagged.timestampMs },
    });
    alerted.push(flagged.digest);
  }
  return { ok: true, operator, scanned: transactions.length, report, alerted };
}
