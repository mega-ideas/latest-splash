import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import DesignGallery from '@/components/system/gallery/DesignGallery';

export const metadata: Metadata = {
  title: 'Design system gallery',
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Component gallery in both themes. Never indexed; only served when the
 * gallery flag is on or outside production.
 */
export default function DesignPage() {
  const enabled = process.env.NEXT_PUBLIC_DESIGN_GALLERY === 'true' || process.env.NODE_ENV !== 'production';
  if (!enabled) notFound();
  return <DesignGallery />;
}
