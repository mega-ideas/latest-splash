/**
 * Isometric v2 — shared JSX primitives. Every face in the library is drawn
 * through Box / Prism so geometry stays on the same projection.
 */
import type { CSSProperties, ReactNode } from 'react';
import {
  boxPath,
  GRID,
  IsoPalette,
  isoPoint,
  LABEL_FONT,
  LABEL_H,
  LABEL_LIFT,
  labelWidth,
  MONO,
  padBounds,
  polyPath,
  prismPath,
  shadowPath,
  STROKE,
  viewBoxOf,
  type Bounds,
  type Pt,
} from './iso';

/** Props shared by every module and composition. */
export interface IsoModuleProps {
  className?: string;
  /** Visible flat label (rendered on a plane above the object). */
  label?: string;
  /** Max rendered width in px; the SVG is otherwise 100% wide. */
  size?: number;
  /** Accessible name. Ignored when `decorative` is true. */
  ariaLabel?: string;
  /** Hide from assistive tech. */
  decorative?: boolean;
}

export interface IsoSvgProps {
  bounds: Bounds;
  pad?: number;
  ariaLabel: string;
  decorative?: boolean;
  className?: string;
  size?: number;
  children: ReactNode;
}

export function IsoSvg({ bounds, pad = GRID, ariaLabel, decorative, className, size, children }: IsoSvgProps) {
  const style: CSSProperties = { display: 'block', height: 'auto', maxWidth: size };
  return (
    <svg
      viewBox={viewBoxOf(padBounds(bounds, pad))}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      className={className}
      style={style}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : ariaLabel}
      aria-hidden={decorative ? true : undefined}
    >
      {children}
    </svg>
  );
}

export interface BoxProps {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  top?: string;
  left?: string;
  right?: string;
  stroke?: string;
  strokeWidth?: number;
  shadow?: boolean;
  children?: ReactNode;
}

export function Box({
  x, y, z, w, d, h,
  top = IsoPalette.top,
  left = IsoPalette.side,
  right = IsoPalette.sideShade,
  stroke = IsoPalette.ink,
  strokeWidth = STROKE,
  shadow = true,
  children,
}: BoxProps) {
  const f = boxPath(x, y, z, w, d, h);
  return (
    <g>
      {shadow && <path d={shadowPath(x, y, w, d)} fill={IsoPalette.shadow} />}
      <path d={f.left} fill={left} />
      <path d={f.right} fill={right} />
      <path d={f.top} fill={top} />
      <path d={f.edges} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      <path d={f.outline} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      {children}
    </g>
  );
}

export interface PrismProps {
  poly: readonly Pt[];
  z: number;
  h: number;
  top?: string;
  stroke?: string;
  strokeWidth?: number;
  shadow?: boolean;
  children?: ReactNode;
}

export function Prism({ poly, z, h, top = IsoPalette.top, stroke = IsoPalette.ink, strokeWidth = STROKE, shadow = true, children }: PrismProps) {
  const f = prismPath(poly, z, h);
  const s = GRID / 2;
  return (
    <g>
      {shadow && <path d={polyPath(poly.map(([px, py]) => isoPoint(px + s, py + s)))} fill={IsoPalette.shadow} />}
      {f.sides.map((side, i) => (
        <path key={i} d={side.path} fill={side.lit ? IsoPalette.side : IsoPalette.sideShade} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      ))}
      <path d={f.top} fill={top} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      {children}
    </g>
  );
}

export interface LabelPlaneProps {
  /** Screen anchor: the object's top centre. */
  anchor: Pt;
  text: string;
  lift?: number;
  leader?: boolean;
  fill?: string;
  ink?: string;
}

/** Flat label plane floating above an object, mono type, with a hairline leader. */
export function LabelPlane({ anchor, text, lift = LABEL_LIFT, leader = true, fill = IsoPalette.side, ink = IsoPalette.ink }: LabelPlaneProps) {
  const [ax, ay] = anchor;
  const w = labelWidth(text);
  const cy = ay - lift - LABEL_H / 2;
  return (
    <g>
      {leader && <line x1={ax} y1={ay} x2={ax} y2={cy + LABEL_H / 2} stroke={IsoPalette.line200} strokeWidth={1} />}
      <rect x={ax - w / 2} y={cy - LABEL_H / 2} width={w} height={LABEL_H} rx={2} fill={fill} stroke={ink} strokeWidth={1} />
      <text x={ax} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={LABEL_FONT} fill={ink} style={{ fontFamily: MONO }}>
        {text}
      </text>
    </g>
  );
}

export interface CaptionProps {
  at: Pt;
  text: string;
  anchor?: 'start' | 'middle' | 'end';
  fill?: string;
}

/** Small flat mono caption (no plane) — used beside slabs and under towers. */
export function Caption({ at, text, anchor = 'start', fill = IsoPalette.text2 }: CaptionProps) {
  return (
    <text x={at[0]} y={at[1]} textAnchor={anchor} dominantBaseline="central" fontSize={9} fill={fill} style={{ fontFamily: MONO }}>
      {text}
    </text>
  );
}

export interface GridPlaneProps {
  x: number;
  y: number;
  w: number;
  d: number;
  step?: number;
  fill?: string;
}

/** Flat ground plane ruled on the 8px iso grid. */
export function GridPlane({ x, y, w, d, step = GRID, fill = IsoPalette.plane }: GridPlaneProps) {
  const lines: string[] = [];
  for (let i = step; i < d; i += step) {
    const a = isoPoint(x, y + i);
    const b = isoPoint(x + w, y + i);
    lines.push(`M${a[0]} ${a[1]} L${b[0]} ${b[1]}`);
  }
  for (let j = step; j < w; j += step) {
    const a = isoPoint(x + j, y);
    const b = isoPoint(x + j, y + d);
    lines.push(`M${a[0]} ${a[1]} L${b[0]} ${b[1]}`);
  }
  const rim = polyPath([isoPoint(x, y), isoPoint(x + w, y), isoPoint(x + w, y + d), isoPoint(x, y + d)]);
  return (
    <g>
      <path d={rim} fill={fill} />
      <path d={lines.join(' ')} fill="none" stroke={IsoPalette.line100} strokeWidth={0.75} />
      <path d={rim} fill="none" stroke={IsoPalette.line200} strokeWidth={1} />
    </g>
  );
}
