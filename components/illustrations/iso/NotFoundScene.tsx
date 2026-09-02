'use client';

/**
 * NotFoundScene — a lone ReceiptToken beside an open ApprovalGate, with a
 * mono status-code plane ("404" by default) above the gate.
 *
 * Export sizes: 320 (mobile: crop="focal" shows the receipt only), 640, 1280.
 */
import { ApprovalGateGlyph, gateBounds } from './ApprovalGate';
import { GRID, unionBounds, type Vec3 } from './iso';
import { IsoSvg, type IsoModuleProps } from './primitives';
import { receiptTokenBounds, ReceiptTokenGlyph } from './ReceiptToken';

export interface NotFoundSceneProps extends IsoModuleProps {
  /** Mono label on the plane above the gate. */
  code?: string;
  /** Optional digest fragment shown above the receipt. */
  digest?: string;
  crop?: 'focal' | 'full';
}

const GATE_AT: Vec3 = { x: 0, y: 0, z: 0 };
const RECEIPT_AT: Vec3 = { x: 5 * GRID, y: 3 * GRID, z: 0 };

export function NotFoundScene({ className, size, label, ariaLabel, decorative, code = '404', digest, crop = 'full' }: NotFoundSceneProps) {
  const name = ariaLabel ?? label ?? `${code} — page not found`;

  if (crop === 'focal') {
    return (
      <IsoSvg bounds={receiptTokenBounds(GATE_AT, code)} ariaLabel={name} decorative={decorative} className={className} size={size}>
        <ReceiptTokenGlyph at={GATE_AT} digest={code} />
      </IsoSvg>
    );
  }

  const bounds = unionBounds(gateBounds(GATE_AT, code), receiptTokenBounds(RECEIPT_AT, digest));
  return (
    <IsoSvg bounds={bounds} pad={2 * GRID} ariaLabel={name} decorative={decorative} className={className} size={size}>
      <ApprovalGateGlyph at={GATE_AT} open label={code} />
      <ReceiptTokenGlyph at={RECEIPT_AT} digest={digest} />
    </IsoSvg>
  );
}

export default NotFoundScene;
