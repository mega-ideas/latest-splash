/**
 * The landing's large art, as scripts/landing-images.mjs wrote it.
 *
 * Client-safe: the manifest is JSON beside this file. A component asks for a
 * piece by key and gets what next/image needs: a key for `src`, the size of
 * the widest file, and a loader that picks the pre-made WebP for each width
 * in the srcset. The optimizer never runs on these, and the PNG originals in
 * public/cinematic/ are never requested.
 */
import type { ImageLoader } from 'next/image';

import manifest from './images.json';

export type LandingImageKey = keyof typeof manifest;

type Variant = { src: string; width: number; height: number; bytes: number };

export type LandingImage = {
  /** What next/image is given as `src`: a key, never a file, so the loader always runs. */
  src: string;
  width: number;
  height: number;
  loader: ImageLoader;
  /** The crop for phones. */
  phone: Variant;
};

/** The smallest file at least `width` wide, or the widest there is. */
export function variantFor(variants: readonly Variant[], width: number): Variant {
  const sorted = [...variants].sort((a, b) => a.width - b.width);
  return sorted.find((v) => v.width >= width) ?? sorted[sorted.length - 1];
}

export function landingImage(key: LandingImageKey): LandingImage {
  const entry = manifest[key];
  const variants: Variant[] = entry.variants;
  const widest = variants.reduce((a, b) => (b.width > a.width ? b : a));
  return {
    src: `/cinematic/landing/${key}`,
    width: widest.width,
    height: widest.height,
    loader: ({ width }) => variantFor(variants, width).src,
    phone: entry.phone,
  };
}
