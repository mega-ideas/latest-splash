import Image from 'next/image';
import Link from 'next/link';

import { brand } from '@/lib/brand';

/** Icon + wordmark, linked home. The only place the wordmark is spelled. */
export default function Wordmark({
  href = '/',
  size = 32,
  className = '',
  showText = true,
}: {
  href?: string;
  size?: number;
  className?: string;
  showText?: boolean;
}) {
  return (
    <Link href={href} className={`brand-wordmark ${className}`.trim()} aria-label={`${brand.name} home`}>
      <Image src={brand.assets.icon} alt="" width={size} height={Math.round(size * 0.98)} className="brand-wordmark-icon" />
      {showText ? (
        <strong className="brand-wordmark-text">
          {brand.wordmark}
          <span aria-hidden="true">.</span>
        </strong>
      ) : null}
    </Link>
  );
}
