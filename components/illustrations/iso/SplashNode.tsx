/**
 * SplashNode — hexagonal prism (elevation 2) carrying the brand ring on its
 * top face. `focal` switches to the 2px focal stroke.
 */
import {
  boxBounds,
  ELEVATION,
  GRID,
  IsoPalette,
  isoEllipse,
  isoPoint,
  labelRoom,
  ORIGIN,
  regularPolygon,
  STROKE,
  STROKE_FOCAL,
  type Bounds,
  type Vec3,
} from './iso';
import { IsoSvg, LabelPlane, Prism, type IsoModuleProps } from './primitives';

export const SPLASH_NODE = { r: 3 * GRID, h: ELEVATION[2] } as const;

export interface SplashNodeGlyphProps {
  /** World position of the node's footprint centre. */
  at?: Vec3;
  label?: string;
  focal?: boolean;
}

export function splashNodeBounds(at: Vec3 = ORIGIN, label?: string): Bounds {
  const { r, h } = SPLASH_NODE;
  return labelRoom(boxBounds(at.x - r, at.y - r, at.z, 2 * r, 2 * r, h), label);
}

export function SplashNodeGlyph({ at = ORIGIN, label, focal = false }: SplashNodeGlyphProps) {
  const { r, h } = SPLASH_NODE;
  const { x, y, z } = at;
  const poly = regularPolygon(x, y, r, 6);
  const sw = focal ? STROKE_FOCAL : STROKE;
  const ring = isoEllipse(x, y, z + h, r * 0.62);
  const core = isoEllipse(x, y, z + h, r * 0.22);
  return (
    <g>
      <Prism poly={poly} z={z} h={h} strokeWidth={sw}>
        <ellipse cx={ring.cx} cy={ring.cy} rx={ring.rx} ry={ring.ry} fill="none" stroke={IsoPalette.brand} strokeWidth={sw} />
        <ellipse cx={core.cx} cy={core.cy} rx={core.rx} ry={core.ry} fill={IsoPalette.brand} />
      </Prism>
      {label && <LabelPlane anchor={isoPoint(x, y, z + h)} text={label} />}
    </g>
  );
}

export interface SplashNodeProps extends IsoModuleProps, SplashNodeGlyphProps {}

export function SplashNode({ className, size, label, ariaLabel, decorative, at = ORIGIN, focal }: SplashNodeProps) {
  return (
    <IsoSvg bounds={splashNodeBounds(at, label)} ariaLabel={ariaLabel ?? label ?? 'Splash node'} decorative={decorative} className={className} size={size}>
      <SplashNodeGlyph at={at} label={label} focal={focal} />
    </IsoSvg>
  );
}

export default SplashNode;
