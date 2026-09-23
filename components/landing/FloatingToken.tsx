'use client';

import Image from 'next/image';
import { useState } from 'react';

/**
 * A floating isometric token that coin-spins five times when clicked.
 * Position it with an absolutely-positioned wrapper (`.cin-drop`) inside a
 * relatively-positioned section.
 */
export default function FloatingToken({
  src,
  alt,
  size = 120,
  float = 'cin-float',
  className = '',
}: {
  src: string;
  alt: string;
  size?: number;
  float?: string;
  className?: string;
}) {
  const [spinning, setSpinning] = useState(false);

  return (
    <button
      type="button"
      className={`cin-token-button ${spinning ? 'is-spinning' : ''} ${className}`}
      style={{ width: size }}
      onClick={() => setSpinning(true)}
      onAnimationEnd={(event) => {
        if (event.animationName === 'cin-spin') setSpinning(false);
      }}
      aria-label={`${alt} — spin`}
    >
      <span className={`cin-token-inner ${float}`}>
        <Image src={src} alt="" width={1024} height={1024} sizes={`${size}px`} loading="eager" />
      </span>
    </button>
  );
}
