'use client';

import Image from 'next/image';
import { motion, useReducedMotion } from 'framer-motion';

import { LoadingScene } from '@/components/illustrations/iso';
import { brand } from '@/lib/brand';

/**
 * Full-screen loading panel: the Sui settlement stack assembling on loop
 * (static under reduced motion) with the brand mark and a plain status line.
 */
export default function SplashLoading({ label = 'Loading your desk' }: { label?: string }) {
  const reduce = useReducedMotion();
  return (
    <div className="splash-loading-shell" role="status" aria-live="polite">
      <div className="splash-loading-grid" aria-hidden="true" />
      <div className="splash-loading-panel">
        <div className="splash-loading-art">
          <LoadingScene size={200} decorative />
        </div>
        <div className="splash-loading-copy">
          <Image src={brand.assets.icon} alt="" width={48} height={47} loading="eager" />
          <span>
            <motion.strong animate={reduce ? undefined : { opacity: [0.45, 1, 0.45] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}>
              {label}
            </motion.strong>
            <small>Preparing settlement, receipts, and proof</small>
          </span>
        </div>
      </div>
    </div>
  );
}
