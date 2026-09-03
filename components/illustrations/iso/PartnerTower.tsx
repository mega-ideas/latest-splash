/**
 * PartnerTower — a taller tower (elevation 2) with a currency chip plane.
 * `label` (e.g. a country code) renders as a flat caption under the tower.
 */
import { boxBounds, ELEVATION, GRID, IsoPalette, isoPoint, labelRoom, ORIGIN, topCenter, type Bounds, type Vec3 } from './iso';
import { Box, Caption, IsoSvg, LabelPlane, type IsoModuleProps } from './primitives';

export const PARTNER_TOWER = { w: 4 * GRID, d: 4 * GRID, h: ELEVATION[2] } as const;

export interface PartnerTowerGlyphProps {
  at?: Vec3;
  /** Currency code shown on the chip plane, e.g. "PHP". */
  currency?: string;
  label?: string;
}

export function partnerTowerBounds(at: Vec3 = ORIGIN, currency = 'PHP', label?: string): Bounds {
  const { w, d, h } = PARTNER_TOWER;
  const b = labelRoom(boxBounds(at.x, at.y, at.z, w, d, h), currency);
  return label ? { ...b, maxY: b.maxY + 14 } : b;
}

export function PartnerTowerGlyph({ at = ORIGIN, currency = 'PHP', label }: PartnerTowerGlyphProps) {
  const { w, d, h } = PARTNER_TOWER;
  const { x, y, z } = at;
  const seam = z + h * 0.66;
  const a = isoPoint(x, y + d, seam);
  const b = isoPoint(x + w, y + d, seam);
  const c = isoPoint(x + w, y, seam);
  const front = isoPoint(x + w, y + d, z);
  return (
    <g>
      <Box x={x} y={y} z={z} w={w} d={d} h={h}>
        <path d={`M${a[0]} ${a[1]} L${b[0]} ${b[1]} L${c[0]} ${c[1]}`} fill="none" stroke={IsoPalette.ink} strokeWidth={1} />
      </Box>
      <LabelPlane anchor={topCenter(x, y, z, w, d, h)} text={currency} />
      {label && <Caption at={[front[0], front[1] + 10]} text={label} anchor="middle" />}
    </g>
  );
}

export interface PartnerTowerProps extends IsoModuleProps, PartnerTowerGlyphProps {}

export function PartnerTower({ className, size, label, ariaLabel, decorative, at = ORIGIN, currency = 'PHP' }: PartnerTowerProps) {
  return (
    <IsoSvg
      bounds={partnerTowerBounds(at, currency, label)}
      ariaLabel={ariaLabel ?? `${currency} partner${label ? ` (${label})` : ''}`}
      decorative={decorative}
      className={className}
      size={size}
    >
      <PartnerTowerGlyph at={at} currency={currency} label={label} />
    </IsoSvg>
  );
}

export default PartnerTower;
