import ContractConfigForm from '@/components/admin/ContractConfigForm';
import {
  CONTRACT_CONFIG_FIELDS,
  type ContractConfigField,
  getContractConfig,
  getContractConfigMeta,
  getEnvKeyFor,
} from '@/lib/server/contract-config';

export const dynamic = 'force-dynamic';

export default function ContractsPage() {
  const config = getContractConfig();
  const env: Record<string, string> = {};
  for (const field of CONTRACT_CONFIG_FIELDS as ContractConfigField[]) {
    env[field] = (process.env[getEnvKeyFor(field)] ?? '').trim();
  }
  const meta = getContractConfigMeta();
  const network = process.env.SUI_NETWORK ?? 'testnet';

  return (
    <div className="mx-auto max-w-6xl">
      <ContractConfigForm
        initialConfig={config}
        initialEnv={env}
        initialMeta={meta}
        network={network}
      />
    </div>
  );
}
