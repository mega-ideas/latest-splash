import { getNetworkProfile } from '@/lib/network';

/**
 * Full-width sandbox ribbon. Renders only when the deployment is on testnet;
 * on mainnet it renders nothing at all (the nav badge carries the live state).
 */
export default function SandboxRibbon() {
  const { badges } = getNetworkProfile();
  if (!badges.ribbon) return null;
  return (
    <div className="brand-sandbox-ribbon" role="status">
      <span className="brand-sandbox-ribbon-dot" aria-hidden="true" />
      {badges.ribbon}
    </div>
  );
}
