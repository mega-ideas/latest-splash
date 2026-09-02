import Link from 'next/link';

import { brand } from '@/lib/brand';
import { getNetworkProfile } from '@/lib/network';

/**
 * The posture line every page footer carries: technology platform, not a
 * bank; operated by the legal entity; regulator-ready by design (a design
 * claim about the package split, never a licence claim). Links to /trust and
 * shows the env-driven network state.
 */
export default function PostureFooter({ className = '' }: { className?: string }) {
  const { badges } = getNetworkProfile();
  return (
    <div className={`brand-posture ${className}`.trim()}>
      <p className="brand-posture-line">
        {brand.postureLine}{' '}
        <Link href="/trust" className="brand-posture-link">
          Trust &amp; compliance
        </Link>
      </p>
      <p className="brand-posture-meta">
        <span>{badges.live ?? badges.network}</span>
        <span>{badges.corridorLine}</span>
      </p>
    </div>
  );
}
