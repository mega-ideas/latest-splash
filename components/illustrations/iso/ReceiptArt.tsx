'use client';

/**
 * ReceiptArt — a ReceiptToken floating over a small settled slab, for receipt
 * headers. The slab carries the green-100 settled material.
 *
 * Export sizes: 320 (mobile: crop="focal" shows the receipt only), 640, 1280.
 */
import { boxBounds, GRID, IsoPalette, unionBounds, type Vec3 } from './iso';
import { Box, IsoSvg, type IsoModuleProps } from './primitives';
import { receiptTokenBounds, ReceiptTokenGlyph } from './ReceiptToken';
import { STACK } from './SuiSettlementStack';

export interface ReceiptArtProps extends IsoModuleProps {
  /** Digest fragment shown above the receipt, e.g. "0x3f9a…c21e". */
  digest?: string;
  crop?: 'focal' | 'full';
}

const SLAB = { x: 0, y: 0, z: 0, w: STACK.w, d: STACK.d, h: STACK.slab } as const;
const RECEIPT_AT: Vec3 = { x: 2 * GRID, y: GRID / 2, z: SLAB.h };

export function ReceiptArt({ className, size, label, ariaLabel, decorative, digest, crop = 'full' }: ReceiptArtProps) {
  const name = ariaLabel ?? label ?? (digest ? `Settled receipt ${digest}` : 'Settled receipt');
  const text = digest ?? label;

  if (crop === 'focal') {
    const at: Vec3 = { x: 0, y: 0, z: 0 };
    return (
      <IsoSvg bounds={receiptTokenBounds(at, text)} ariaLabel={name} decorative={decorative} className={className} size={size}>
        <ReceiptTokenGlyph at={at} digest={text} />
      </IsoSvg>
    );
  }

  const bounds = unionBounds(boxBounds(SLAB.x, SLAB.y, SLAB.z, SLAB.w, SLAB.d, SLAB.h), receiptTokenBounds(RECEIPT_AT, text));
  return (
    <IsoSvg bounds={bounds} pad={2 * GRID} ariaLabel={name} decorative={decorative} className={className} size={size}>
      <Box {...SLAB} top={IsoPalette.settled} />
      <ReceiptTokenGlyph at={RECEIPT_AT} digest={text} />
    </IsoSvg>
  );
}

export default ReceiptArt;
