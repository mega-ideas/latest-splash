'use client';
/**
 * RouteConnector — a dotted isometric route between two world points with
 * three travelling dots (2.5s loop, staggered). Routes follow the iso axes:
 * along x first, then y. Static under reduced motion.
 */
import { useEffect, useMemo } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from 'framer-motion';
import { boundsOf, IsoPalette, isoPoint, isoVec, type Bounds, type IsoTone, type IsoVec, type Pt } from './iso';
import { IsoSvg, type IsoModuleProps } from './primitives';

export const ROUTE_DURATION = 2.5;

export interface RouteConnectorGlyphProps {
  from: IsoVec;
  to: IsoVec;
  tone?: IsoTone;
  dots?: number;
  duration?: number;
}

export function routePoints(from: IsoVec, to: IsoVec): Pt[] {
  const a = isoVec(from);
  const b = isoVec(to);
  if (from.x === to.x || from.y === to.y) return [a, b];
  return [a, isoPoint(to.x, from.y, from.z ?? 0), b];
}

export function routeBounds(from: IsoVec, to: IsoVec): Bounds {
  return boundsOf(routePoints(from, to));
}

function pointAt(pts: readonly Pt[], t: number): Pt {
  const lengths = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  const total = lengths.reduce((s, l) => s + l, 0);
  let rest = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (rest <= lengths[i] || i === lengths.length - 1) {
      const k = lengths[i] === 0 ? 0 : rest / lengths[i];
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k];
    }
    rest -= lengths[i];
  }
  return pts[pts.length - 1];
}

function Dot({ t, phase, pts, color }: { t: MotionValue<number>; phase: number; pts: readonly Pt[]; color: string }) {
  const local = useTransform(t, (v) => (v + phase) % 1);
  const cx = useTransform(local, (v) => pointAt(pts, v)[0]);
  const cy = useTransform(local, (v) => pointAt(pts, v)[1]);
  const opacity = useTransform(local, [0, 0.1, 0.9, 1], [0, 1, 1, 0]);
  return <motion.circle r={2.5} cx={cx} cy={cy} opacity={opacity} fill={color} />;
}

export function RouteConnectorGlyph({ from, to, tone = 'entry', dots = 3, duration = ROUTE_DURATION }: RouteConnectorGlyphProps) {
  const reduce = useReducedMotion() ?? false;
  const t = useMotionValue(0);
  const pts = useMemo(() => routePoints(from, to), [from, to]);
  useEffect(() => {
    if (reduce) return;
    const controls = animate(t, [0, 1], { duration, ease: 'linear', repeat: Infinity, repeatType: 'loop' });
    return () => controls.stop();
  }, [reduce, duration, t]);
  const color = tone === 'settled' ? IsoPalette.settledInk : IsoPalette.text2;
  const track = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
  return (
    <g>
      <path d={track} fill="none" stroke={IsoPalette.line200} strokeWidth={1.5} strokeDasharray="1.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
      {Array.from({ length: dots }, (_, i) => {
        if (reduce) {
          const [cx, cy] = pointAt(pts, (i + 0.5) / dots);
          return <circle key={i} r={2.5} cx={cx} cy={cy} fill={color} />;
        }
        return <Dot key={i} t={t} phase={i / dots} pts={pts} color={color} />;
      })}
    </g>
  );
}

export interface RouteConnectorProps extends IsoModuleProps, RouteConnectorGlyphProps {}

export function RouteConnector({ className, size, label, ariaLabel, decorative, ...route }: RouteConnectorProps) {
  return (
    <IsoSvg bounds={routeBounds(route.from, route.to)} ariaLabel={ariaLabel ?? label ?? `${route.tone ?? 'entry'} route`} decorative={decorative} className={className} size={size}>
      <RouteConnectorGlyph {...route} />
    </IsoSvg>
  );
}

export default RouteConnector;
