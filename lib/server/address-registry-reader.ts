/**
 * Which addresses Splash's on-chain registry classifies, read-only, over Sui
 * GraphQL: splash_core::address_registry::Registry (SPLASH_ADDRESS_REGISTRY_ID)
 * holds the payout partners' deposit addresses and every account's current
 * business wallet, each in a Table keyed by address.
 *
 * The operator-outflow monitor asks it about the addresses that gained value
 * on a v2 executor payment and are not wallet beneficiaries: a bank payout
 * goes to a partner's deposit address, and a payment between Splash
 * businesses to a business wallet. Nothing here writes, signs or holds a key.
 *
 * It fails closed: an object of another type, or an answer the indexer did
 * not complete, throws, and the monitor then reports that it could not read
 * its inputs rather than clearing a payment it could not check.
 */

type Fetcher = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
const TIMEOUT_MS = 8_000;
const REGISTRY_TYPE = /^(?:0x)?[0-9a-fA-F]{1,64}::address_registry::Registry$/;

function defaultEndpoint(): string {
  const configured = process.env.SUI_GRAPHQL_URL?.trim();
  if (configured) return configured;
  return process.env.SUI_NETWORK === 'mainnet' ? 'https://graphql.mainnet.sui.io/graphql' : 'https://graphql.testnet.sui.io/graphql';
}

function normalize(value: string): string {
  return `0x${value.trim().toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

async function query(fetcher: Fetcher, endpoint: string, text: string, variables: Record<string, string>): Promise<Json> {
  const res = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: text, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`the Sui indexer answered HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown; errors?: Array<{ message?: string }> };
  if (body?.errors?.length) throw new Error(`the Sui indexer refused the query: ${body.errors[0]?.message ?? 'unknown error'}`);
  if (!isObject(body?.data)) throw new Error('the Sui indexer answered without data');
  return body.data;
}

const REGISTRY_QUERY = `query Registry($id: SuiAddress!) {
  object(address: $id) { asMoveObject { contents { type { repr } json } } }
}`;

const MEMBER_QUERY = `query Member($table: SuiAddress!, $name: Base64!) {
  table: address(address: $table) {
    dynamicField(name: { type: "address", bcs: $name }) { __typename }
  }
}`;

/**
 * A reader that answers, for a list of addresses, the ones the registry at
 * `registryId` holds as a partner deposit address or a business wallet.
 */
export function graphqlRegistryReader(
  registryId: string,
  fetcher: Fetcher = fetch,
  endpoint = defaultEndpoint(),
): (addresses: string[]) => Promise<Set<string>> {
  return async (addresses) => {
    const found = new Set<string>();
    if (addresses.length === 0) return found;
    const data = await query(fetcher, endpoint, REGISTRY_QUERY, { id: registryId });
    const contents = isObject(data.object) && isObject(data.object.asMoveObject) ? data.object.asMoveObject.contents : null;
    const repr = isObject(contents) && isObject(contents.type) ? contents.type.repr : null;
    if (typeof repr !== 'string' || !REGISTRY_TYPE.test(repr)) throw new Error(`${registryId} is not an address_registry::Registry`);
    const json = isObject(contents) ? contents.json : null;
    const tableId = (field: string) => {
      const t = isObject(json) ? json[field] : null;
      const id = isObject(t) ? t.id : null;
      if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(id)) throw new Error(`the registry has no ${field} table`);
      return id;
    };
    const tables = [tableId('partner_addresses'), tableId('business_wallets')];
    for (const raw of new Set(addresses.map(normalize))) {
      const name = Buffer.from(raw.slice(2), 'hex').toString('base64');
      for (const table of tables) {
        const answer = await query(fetcher, endpoint, MEMBER_QUERY, { table, name });
        if (!isObject(answer.table)) throw new Error('the Sui indexer answered without the registry table');
        if (answer.table.dynamicField !== null && answer.table.dynamicField !== undefined) {
          found.add(raw);
          break;
        }
      }
    }
    return found;
  };
}
