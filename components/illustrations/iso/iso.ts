/**
 * Isometric v2 — projection helpers, geometry and palette.
 *
 * Projection: true isometric 30°/30°, fixed camera. World +x runs down-right
 * on screen, world +y runs down-left, +z is straight up. Lighting is constant
 * from the top-left, so the left (+y) face is lit and the right (+x) face is
 * in shade. All world units are px; multiply by GRID for grid units.
 */

export const GRID = 8;
export const ISO_ANGLE = 30;
const RAD = (ISO_ANGLE * Math.PI) / 180;
export const ISO_COS = Math.cos(RAD);
export const ISO_SIN = Math.sin(RAD);

/** Object heights for elevation levels 0 / 1 / 2. */
export const ELEVATION = [0, 3 * GRID, 6 * GRID] as const;
export type ElevationLevel = 0 | 1 | 2;

export const STROKE = 1.5;
export const STROKE_FOCAL = 2;
/** Gap between the top of an object and its label plane. */
export const LABEL_LIFT = 2 * GRID;
export const LABEL_H = 18;
export const LABEL_FONT = 10;
export const MONO = 'var(--font-mono), monospace';

export type Pt = readonly [number, number];
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface IsoVec {
  x: number;
  y: number;
  z?: number;
}
export const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
export type IsoTone = 'entry' | 'settled';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Project a world point (px) to 2D screen space. */
export function isoPoint(x: number, y: number, z = 0): Pt {
  return [r2((x - y) * ISO_COS), r2((x + y) * ISO_SIN - z)];
}

export function isoVec(v: IsoVec): Pt {
  return isoPoint(v.x, v.y, v.z ?? 0);
}

export function polyPath(pts: readonly Pt[]): string {
  return pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ') + ' Z';
}

export interface BoxFaces {
  top: string;
  left: string;
  right: string;
  /** Silhouette hexagon — stroke this for the outer line. */
  outline: string;
  /** The three interior edges meeting at the front-top corner. */
  edges: string;
}

/**
 * Face paths for an axis-aligned box whose back-left-bottom corner is at
 * (x, y, z), with width w along +x, depth d along +y and height h along +z.
 */
export function boxPath(x: number, y: number, z: number, w: number, d: number, h: number): BoxFaces {
  const t = z + h;
  const A = isoPoint(x, y, t);
  const B = isoPoint(x + w, y, t);
  const C = isoPoint(x + w, y + d, t);
  const D = isoPoint(x, y + d, t);
  const Bb = isoPoint(x + w, y, z);
  const Cb = isoPoint(x + w, y + d, z);
  const Db = isoPoint(x, y + d, z);
  return {
    top: polyPath([A, B, C, D]),
    left: polyPath([D, C, Cb, Db]),
    right: polyPath([B, C, Cb, Bb]),
    outline: polyPath([A, B, Bb, Cb, Db, D]),
    edges: `M${D[0]} ${D[1]} L${C[0]} ${C[1]} L${B[0]} ${B[1]} M${C[0]} ${C[1]} L${Cb[0]} ${Cb[1]}`,
  };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(pts: readonly Pt[]): Bounds {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

export function boxBounds(x: number, y: number, z: number, w: number, d: number, h: number): Bounds {
  const t = z + h;
  return boundsOf([
    isoPoint(x, y, t),
    isoPoint(x + w, y, t),
    isoPoint(x + w, y, z),
    isoPoint(x + w, y + d, z),
    isoPoint(x, y + d, z),
    isoPoint(x, y + d, t),
  ]);
}

export function unionBounds(...bs: Bounds[]): Bounds {
  return bs.reduce((a, b) => ({
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }));
}

export function padBounds(b: Bounds, pad: number): Bounds {
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/** Extend bounds upward to leave room for a label plane. */
export function labelRoom(b: Bounds, labelText?: string): Bounds {
  const extra = LABEL_LIFT + LABEL_H + 2;
  const half = labelText ? labelWidth(labelText) / 2 : 0;
  const cx = (b.minX + b.maxX) / 2;
  return {
    ...b,
    minY: b.minY - extra,
    minX: Math.min(b.minX, cx - half),
    maxX: Math.max(b.maxX, cx + half),
  };
}

export function viewBoxOf(b: Bounds): string {
  return `${r2(b.minX)} ${r2(b.minY)} ${r2(b.maxX - b.minX)} ${r2(b.maxY - b.minY)}`;
}

/** A circle of radius r lying flat in the ground plane, projected. */
export function isoEllipse(cx: number, cy: number, z: number, r: number) {
  const [x, y] = isoPoint(cx, cy, z);
  return { cx: x, cy: y, rx: r2(r * Math.SQRT2 * ISO_COS), ry: r2(r * Math.SQRT2 * ISO_SIN) };
}

/** Regular polygon in the world xy plane (CCW). Rotation 45° keeps it screen-symmetric. */
export function regularPolygon(cx: number, cy: number, r: number, sides = 6, rotation = 45): Pt[] {
  return Array.from({ length: sides }, (_, i) => {
    const a = ((rotation + (360 / sides) * i) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  });
}

export interface PrismFaces {
  top: string;
  sides: { path: string; lit: boolean }[];
}

/** Extrude a CCW world-xy polygon from z to z+h; only viewer-facing sides are returned. */
export function prismPath(poly: readonly Pt[], z: number, h: number): PrismFaces {
  const n = poly.length;
  const top = polyPath(poly.map(([x, y]) => isoPoint(x, y, z + h)));
  const sides: PrismFaces['sides'] = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    const nx = y2 - y1;
    const ny = -(x2 - x1);
    if (nx + ny <= 1e-6) continue; // faces away from the camera at (+1, +1)
    sides.push({
      path: polyPath([isoPoint(x1, y1, z + h), isoPoint(x2, y2, z + h), isoPoint(x2, y2, z), isoPoint(x1, y1, z)]),
      lit: ny > nx,
    });
  }
  return { top, sides };
}

/** Ambient contact shadow: the footprint spread toward the viewer, on the ground. */
export function shadowPath(x: number, y: number, w: number, d: number, spread = GRID / 2): string {
  return polyPath([isoPoint(x, y), isoPoint(x + w + spread, y), isoPoint(x + w + spread, y + d + spread), isoPoint(x, y + d + spread)]);
}

export function topCenter(x: number, y: number, z: number, w: number, d: number, h: number): Pt {
  return isoPoint(x + w / 2, y + d / 2, z + h);
}

export function labelWidth(text: string, fontSize = LABEL_FONT): number {
  return Math.ceil(text.length * fontSize * 0.62) + 12;
}

/** Semantic materials. Fallback hexes are the only ones allowed in components/. */
export const IsoPalette = {
  ink: 'var(--ink-900, #0B2A33)',
  inkSoft: 'var(--ink-700, #163F4A)',
  brand: 'var(--teal-600, #1F7A8C)',
  brandBright: 'var(--teal-500, #2E96A8)',
  teal: 'var(--teal-400, #5C9EAD)',
  top: 'var(--teal-100, #DCEEF1)',
  side: 'var(--surface, #FFFFFF)',
  sideShade: 'var(--surface-dim, #F7F8F7)',
  plane: 'var(--surface-plane, #EEF3F4)',
  text2: 'var(--text-2, #4A5C64)',
  text3: 'var(--text-3, #6B7A83)',
  line200: 'var(--line-200, #DCE3E6)',
  line100: 'var(--line-100, #E8EDEF)',
  settledInk: 'var(--green-600, #1E8F6E)',
  settled: 'var(--green-100, #DDF3EA)',
  warnInk: 'var(--amber-600, #B9770E)',
  warn: 'var(--amber-100, #FBEFD9)',
  dangerInk: 'var(--red-600, #B93A32)',
  danger: 'var(--red-100, #FAE3E1)',
  shadow: 'rgba(11,42,51,.08)',
} as const;
