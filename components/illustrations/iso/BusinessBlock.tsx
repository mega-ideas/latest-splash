/**
 * BusinessBlock — a low office block (elevation 1) with a flat label plane.
 */
import { boxBounds, ELEVATION, GRID, IsoPalette, isoPoint, labelRoom, ORIGIN, polyPath, topCenter, type Bounds, type Vec3 } from './iso';
import { Box, IsoSvg, LabelPlane, type IsoModuleProps } from './primitives';

export const BUSINESS_BLOCK = { w: 6 * GRID, d: 6 * GRID, h: ELEVATION[1] } as const;

export interface BusinessBlockGlyphProps {
  at?: Vec3;
  label?: string;
}

export function businessBlockBounds(at: Vec3 = ORIGIN, label?: string): Bounds {
  const { w, d, h } = BUSINESS_BLOCK;
  return labelRoom(boxBounds(at.x, at.y, at.z, w, d, h), label);
}

/** Small parallelogram on the left (+y) face: spans x0..x1 at heights z0..z1. */
function leftWindow(x0: number, x1: number, y: number, z0: number, z1: number) {
  return polyPath([isoPoint(x0, y, z1), isoPoint(x1, y, z1), isoPoint(x1, y, z0), isoPoint(x0, y, z0)]);
}

/** Same on the right (+x) face: spans y0..y1. */
function rightWindow(x: number, y0: number, y1: number, z0: number, z1: number) {
  return polyPath([isoPoint(x, y0, z1), isoPoint(x, y1, z1), isoPoint(x, y1, z0), isoPoint(x, y0, z0)]);
}

export function BusinessBlockGlyph({ at = ORIGIN, label }: BusinessBlockGlyphProps) {
  const { w, d, h } = BUSINESS_BLOCK;
  const { x, y, z } = at;
  const face = y + d;
  const side = x + w;
  const rows = [z + GRID * 0.75, z + GRID * 1.75];
  return (
    <g>
      <Box x={x} y={y} z={z} w={w} d={d} h={h}>
        {rows.map((z0) =>
          [0, 1, 2].map((i) => (
            <path key={`l${z0}-${i}`} d={leftWindow(x + GRID * (0.75 + i * 1.75), x + GRID * (1.75 + i * 1.75), face, z0, z0 + GRID * 0.75)} fill={IsoPalette.top} />
          )),
        )}
        {rows.map((z0) =>
          [0, 1].map((i) => (
            <path key={`r${z0}-${i}`} d={rightWindow(side, y + GRID * (1 + i * 2), y + GRID * (2 + i * 2), z0, z0 + GRID * 0.75)} fill={IsoPalette.top} />
          )),
        )}
        {/* door on the right face */}
        <path d={rightWindow(side, y + GRID * 4.5, y + GRID * 5.25, z, z + GRID * 1.5)} fill={IsoPalette.ink} />
      </Box>
      {/* roof unit */}
      <Box x={x + GRID * 3.5} y={y + GRID} z={z + h} w={GRID * 1.5} d={GRID * 1.5} h={GRID * 0.75} shadow={false} />
      {label && <LabelPlane anchor={topCenter(x, y, z, w, d, h)} text={label} />}
    </g>
  );
}

export interface BusinessBlockProps extends IsoModuleProps, BusinessBlockGlyphProps {}

export function BusinessBlock({ className, size, label, ariaLabel, decorative, at = ORIGIN }: BusinessBlockProps) {
  return (
    <IsoSvg bounds={businessBlockBounds(at, label)} ariaLabel={ariaLabel ?? label ?? 'Business'} decorative={decorative} className={className} size={size}>
      <BusinessBlockGlyph at={at} label={label} />
    </IsoSvg>
  );
}

export default BusinessBlock;
