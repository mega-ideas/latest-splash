'use client';
/**
 * ApprovalGate — two posts and a barrier that spans world +y. Closed by
 * default; `open` swings the barrier up around the hinge post (spring,
 * reduced-motion aware).
 */
import { useEffect, useRef } from 'react';
import { animate, useMotionValue, useReducedMotion } from 'framer-motion';
import { boundsOf, boxBounds, GRID, isoPoint, labelRoom, ORIGIN, unionBounds, type Bounds, type Vec3 } from './iso';
import { Box, IsoSvg, LabelPlane, type IsoModuleProps } from './primitives';

export const GATE = { post: GRID, span: 7 * GRID, height: 4 * GRID, bar: GRID / 2 } as const;
/** Screen-space swing (clockwise) that lifts the +y barrier to near-vertical. */
const OPEN_ANGLE = 110;

export interface ApprovalGateGlyphProps {
  at?: Vec3;
  open?: boolean;
  label?: string;
}

export function gateBounds(at: Vec3 = ORIGIN, label?: string): Bounds {
  const { post, span, height } = GATE;
  const hinge = isoPoint(at.x + post / 2, at.y + post, at.z + height);
  const b = unionBounds(
    boxBounds(at.x, at.y, at.z, post, post, height),
    boxBounds(at.x, at.y + span, at.z, post, post, height),
    boundsOf([[hinge[0], hinge[1] - (span - post)]]),
  );
  return labelRoom(b, label);
}

export function ApprovalGateGlyph({ at = ORIGIN, open = false, label }: ApprovalGateGlyphProps) {
  const reduce = useReducedMotion() ?? false;
  const { post, span, height, bar } = GATE;
  const { x, y, z } = at;
  const target = open ? OPEN_ANGLE : 0;
  const hinge = isoPoint(x + post / 2, y + post, z + height - bar / 2);
  const angle = useMotionValue(target);
  const barRef = useRef<SVGGElement>(null);
  const [hx, hy] = hinge;

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const apply = (a: number) => el.setAttribute('transform', `rotate(${a} ${hx} ${hy})`);
    if (reduce) {
      angle.jump(target);
      apply(target);
      return;
    }
    const unsubscribe = angle.on('change', apply);
    const controls = animate(angle, target, { type: 'spring', stiffness: 110, damping: 16, mass: 0.8 });
    return () => {
      unsubscribe();
      controls.stop();
    };
  }, [angle, target, reduce, hx, hy]);

  return (
    <g>
      <Box x={x} y={y} z={z} w={post} d={post} h={height} />
      <g ref={barRef} transform={`rotate(${target} ${hx} ${hy})`}>
        <Box x={x + post / 4} y={y + post} z={z + height - bar} w={post / 2} d={span - post} h={bar} shadow={false} />
      </g>
      <Box x={x} y={y + span} z={z} w={post} d={post} h={height} />
      {label && <LabelPlane anchor={isoPoint(x + post / 2, y + span / 2, z + height)} text={label} />}
    </g>
  );
}

export interface ApprovalGateProps extends IsoModuleProps, ApprovalGateGlyphProps {}

export function ApprovalGate({ className, size, label, ariaLabel, decorative, at = ORIGIN, open = false }: ApprovalGateProps) {
  return (
    <IsoSvg bounds={gateBounds(at, label)} ariaLabel={ariaLabel ?? label ?? `Approval gate ${open ? 'open' : 'closed'}`} decorative={decorative} className={className} size={size}>
      <ApprovalGateGlyph at={at} open={open} label={label} />
    </IsoSvg>
  );
}

export default ApprovalGate;
