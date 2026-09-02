/**
 * EmptyState — one focal object on an 8px grid plane, ~240px wide, for empty
 * table slots. The object is chosen by `kind`; copy comes from `label`.
 *
 * Export sizes: 320 (mobile / default 240 slot), 640, 1280 (crop is the same
 * at every size — this scene is already the focal object).
 */
import { ApprovalGateGlyph, GATE, gateBounds } from './ApprovalGate';
import { BUSINESS_BLOCK, businessBlockBounds, BusinessBlockGlyph } from './BusinessBlock';
import { boxBounds, GRID, unionBounds, type Bounds, type Vec3 } from './iso';
import { PARTNER_TOWER, partnerTowerBounds, PartnerTowerGlyph } from './PartnerTower';
import { GridPlane, IsoSvg, type IsoModuleProps } from './primitives';
import { RECEIPT_TOKEN, receiptTokenBounds, ReceiptTokenGlyph } from './ReceiptToken';
import { STACK, stackBounds, SuiSettlementStackGlyph } from './SuiSettlementStack';

export type EmptyStateKind = 'settlements' | 'recipients' | 'approvals' | 'invoices' | 'receipts';

export interface EmptyStateProps extends IsoModuleProps {
  kind: EmptyStateKind;
  crop?: 'focal' | 'full';
}

const PLANE = { x: 0, y: 0, w: 14 * GRID, d: 12 * GRID } as const;

function footprint(kind: EmptyStateKind): { w: number; d: number } {
  switch (kind) {
    case 'settlements':
      return { w: STACK.w, d: STACK.d };
    case 'recipients':
      return { w: PARTNER_TOWER.w, d: PARTNER_TOWER.d };
    case 'approvals':
      return { w: GATE.post, d: GATE.span + GATE.post };
    case 'invoices':
      return { w: BUSINESS_BLOCK.w, d: BUSINESS_BLOCK.d };
    case 'receipts':
      return { w: RECEIPT_TOKEN.w, d: RECEIPT_TOKEN.d };
  }
}

function objectBounds(kind: EmptyStateKind, at: Vec3, label?: string): Bounds {
  switch (kind) {
    case 'settlements':
      return stackBounds(at, undefined, label);
    case 'recipients':
      return partnerTowerBounds(at, label ?? '', undefined);
    case 'approvals':
      return gateBounds(at, label);
    case 'invoices':
      return businessBlockBounds(at, label);
    case 'receipts':
      return receiptTokenBounds(at, label);
  }
}

function Focal({ kind, at, label }: { kind: EmptyStateKind; at: Vec3; label?: string }) {
  switch (kind) {
    case 'settlements':
      return <SuiSettlementStackGlyph at={at} label={label} focal />;
    case 'recipients':
      return <PartnerTowerGlyph at={at} currency={label ?? ''} />;
    case 'approvals':
      return <ApprovalGateGlyph at={at} label={label} />;
    case 'invoices':
      return <BusinessBlockGlyph at={at} label={label} />;
    case 'receipts':
      return <ReceiptTokenGlyph at={at} label={label} />;
  }
}

export function EmptyState({ className, size = 240, label, ariaLabel, decorative, kind, crop = 'full' }: EmptyStateProps) {
  const fp = footprint(kind);
  const at: Vec3 = { x: PLANE.x + (PLANE.w - fp.w) / 2, y: PLANE.y + (PLANE.d - fp.d) / 2, z: 0 };
  const object = objectBounds(kind, at, label);
  const bounds = crop === 'focal' ? object : unionBounds(boxBounds(PLANE.x, PLANE.y, 0, PLANE.w, PLANE.d, 0), object);
  return (
    <IsoSvg bounds={bounds} ariaLabel={ariaLabel ?? label ?? `No ${kind} yet`} decorative={decorative} className={className} size={size}>
      {crop === 'full' && <GridPlane {...PLANE} />}
      <Focal kind={kind} at={at} label={label} />
    </IsoSvg>
  );
}

export default EmptyState;
