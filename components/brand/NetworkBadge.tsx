import { getNetworkProfile } from '@/lib/network';

/**
 * Env-driven network badge for chrome (nav, sidebar, footers).
 *
 * "Live on Sui mainnet" renders only when the profile is mainnet AND the core
 * package id is real; otherwise the sandbox label. Never a hardcoded network
 * string — cutover is an env change.
 */
export default function NetworkBadge({ className = '' }: { className?: string }) {
  const profile = getNetworkProfile();
  const label = profile.badges.live ?? profile.badges.network;
  const detail = profile.live ? 'protocol live' : 'no customer funds';
  return (
    <span
      className={`brand-network-badge${profile.live ? ' is-live' : ''} ${className}`.trim()}
      data-network={profile.network}
    >
      <small>{profile.live ? 'Mainnet' : 'Sandbox'}</small>
      <strong>{label}</strong>
      <span className="brand-network-badge-detail">{detail}</span>
    </span>
  );
}
