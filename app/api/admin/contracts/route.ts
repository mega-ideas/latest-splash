import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { resolveNetwork } from '@/lib/network';
import {
  CONTRACT_CONFIG_FIELDS,
  type ContractConfig,
  type ContractConfigField,
  getContractConfig,
  getContractConfigMeta,
  getEnvKeyFor,
  saveContractConfig,
  validateContractConfig,
} from '@/lib/server/contract-config';
import { readJsonBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/**
 * Fields this route refuses to write, no matter who is signed in.
 *
 * Audit finding (high): `testRecipientAddress` is an unconditional OVERRIDE of
 * the payout recipient on every settlement path — single, batch (per row) and
 * composed. `getContractConfig()` merges `data/contract-config.json` OVER the
 * env fallback, and this route's entire authorization was "is there an admin
 * session". So a stolen admin cookie — no signing key required — could PUT
 * `{"testRecipientAddress": "0x<attacker>"}` and silently redirect every
 * subsequent payout, persisted to disk, while the dashboard kept displaying the
 * original beneficiary.
 *
 * These stay ENV-ONLY: changing them is a deployment action with a change
 * record, not a form submission.
 */
const ENV_ONLY_FIELDS = new Set<ContractConfigField>([
  'testRecipientAddress',
]);

function envOnlyView() {
  const result: Record<ContractConfigField, string> = {} as Record<ContractConfigField, string>;
  for (const field of CONTRACT_CONFIG_FIELDS) {
    result[field] = (process.env[getEnvKeyFor(field)] ?? '').trim();
  }
  return result;
}

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  const config = getContractConfig();
  return NextResponse.json({
    config,
    env: envOnlyView(),
    envKeys: Object.fromEntries(CONTRACT_CONFIG_FIELDS.map((f) => [f, getEnvKeyFor(f)])),
    meta: getContractConfigMeta(),
    network: resolveNetwork(),
  });
}

export async function PUT(request: Request) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  const body = await readJsonBody(request);

  const input = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}) as Partial<ContractConfig>;
  const sanitized: Partial<ContractConfig> = {};
  const rejected: ContractConfigField[] = [];
  for (const field of CONTRACT_CONFIG_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string') continue;
    if (ENV_ONLY_FIELDS.has(field)) {
      rejected.push(field);
      continue;
    }
    sanitized[field] = value.trim();
  }
  if (rejected.length > 0) {
    console.warn(`[admin/contracts] rejected write to env-only field(s): ${rejected.join(', ')} (actor ${session.email})`);
    return NextResponse.json(
      {
        error:
          `${rejected.join(', ')} can only be set in the environment, not from this console — it overrides the ` +
          'payout recipient on every settlement.',
        fields: rejected,
      },
      { status: 403 },
    );
  }

  const check = validateContractConfig(sanitized);
  if (!check.ok) {
    return NextResponse.json({ error: 'Invalid contract config', fields: check.errors }, { status: 400 });
  }

  try {
    const updated = saveContractConfig(sanitized);
    return NextResponse.json({
      config: updated,
      meta: getContractConfigMeta(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save contract config';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
