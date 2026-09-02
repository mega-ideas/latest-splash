/**
 * BankBlock — a bank block (elevation 1) on a plinth, with a colonnade hint on
 * the lit face.
 */
import { boxBounds, ELEVATION, GRID, IsoPalette, isoPoint, labelRoom, ORIGIN, polyPath, topCenter, type Bounds, type Vec3 } from './iso';
import { Box, IsoSvg, LabelPlane, type IsoModuleProps } from './primitives';

export const BANK_BLOCK = { w: 8 * GRID, d: 6 * GRID, h: ELEVATION[1], plinth: GRID / 2 } as const;

export interface BankBlockGlyphProps {
  at?: Vec3;
  label?: string;
}

export function bankBlockBounds(at: Vec3 = ORIGIN, label?: string): Bounds {
  const { w, d, h, plinth } = BANK_BLOCK;
  return labelRoom(boxBounds(at.x - GRID, at.y - GRID, at.z, w + 2 * GRID, d + 2 * GRID, h + plinth), label);
}

function column(x0: number, y: number, z0: number, z1: number) {
  const cw = GRID * 0.5;
  return polyPath([isoPoint(x0, y, z1), isoPoint(x0 + cw, y, z1), isoPoint(x0 + cw, y, z0), isoPoint(x0, y, z0)]);
}

export function BankBlockGlyph({ at = ORIGIN, label }: BankBlockGlyphProps) {
  const { w, d, h, plinth } = BANK_BLOCK;
  const { x, y, z } = at;
  const base = z + plinth;
  const face = y + d;
  const lintel = base + h - GRID * 0.75;
  const l0 = isoPoint(x, face, lintel);
  const l1 = isoPoint(x + w, face, lintel);
  return (
    <g>
      <Box x={x - GRID} y={y - GRID} z={z} w={w + 2 * GRID} d={d + 2 * GRID} h={plinth} top={IsoPalette.sideShade} />
      <Box x={x} y={y} z={base} w={w} d={d} h={h} shadow={false}>
        {[0, 1, 2, 3].map((i) => (
          <path key={i} d={column(x + GRID * (1 + i * 1.75), face, base + GRID * 0.5, lintel)} fill={IsoPalette.top} stroke={IsoPalette.ink} strokeWidth={1} strokeLinejoin="round" />
        ))}
        <path d={`M${l0[0]} ${l0[1]} L${l1[0]} ${l1[1]}`} fill="none" stroke={IsoPalette.ink} strokeWidth={1} />
      </Box>
      {label && <LabelPlane anchor={topCenter(x, y, base, w, d, h)} text={label} />}
    </g>
  );
}

export interface BankBlockProps extends IsoModuleProps, BankBlockGlyphProps {}

export function BankBlock({ className, size, label, ariaLabel, decorative, at = ORIGIN }: BankBlockProps) {
  return (
    <IsoSvg bounds={bankBlockBounds(at, label)} ariaLabel={ariaLabel ?? label ?? 'Bank'} decorative={decorative} className={className} size={size}>
      <BankBlockGlyph at={at} label={label} />
    </IsoSvg>
  );
}

export default BankBlock;
