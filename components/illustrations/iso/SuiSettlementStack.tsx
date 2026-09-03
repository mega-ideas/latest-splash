/**
 * SuiSettlementStack — three stacked slabs (pay / allocate / prove). The top
 * slab takes the green-100 settled material when `settled` is true.
 * `assembling` drops the slabs in (CSS keyframes `.iso-slab-in`, staggered
 * per slab); `loop` repeats the assembly for loading surfaces
 * (`.iso-slab-loop`). Both are static under reduced motion (globals.css),
 * and the module ships no animation library.
 */
import type { CSSProperties } from 'react';

import { boxBounds, GRID, IsoPalette, isoPoint, labelWidth, ORIGIN, STROKE, STROKE_FOCAL, type Bounds, type Vec3 } from './iso';
import { Box, Caption, IsoSvg, LabelPlane, type IsoModuleProps } from './primitives';

export const STACK = { w: 8 * GRID, d: 6 * GRID, slab: 1.5 * GRID, gap: GRID / 2, count: 3 } as const;
export const STACK_HEIGHT = STACK.count * (STACK.slab + STACK.gap) - STACK.gap;
const DEFAULT_LABELS: readonly [string, string, string] = ['pay', 'allocate', 'prove'];
const DROP = 3 * GRID;

export interface SuiSettlementStackGlyphProps {
  at?: Vec3;
  /** Slab captions, bottom to top. */
  labels?: readonly [string, string, string];
  settled?: boolean;
  assembling?: boolean;
  loop?: boolean;
  focal?: boolean;
  label?: string;
}

export function stackBounds(at: Vec3 = ORIGIN, labels: readonly string[] = DEFAULT_LABELS, label?: string): Bounds {
  const { w, d } = STACK;
  const b = boxBounds(at.x, at.y, at.z, w, d, STACK_HEIGHT);
  const longest = labels.reduce((m, s) => Math.max(m, labelWidth(s, 9)), 0);
  return {
    ...b,
    maxX: b.maxX + 8 + longest,
    minY: label ? b.minY - 3 * GRID - 20 : b.minY - GRID,
  };
}

export function SuiSettlementStackGlyph({
  at = ORIGIN,
  labels = DEFAULT_LABELS,
  settled = false,
  assembling = false,
  loop = false,
  focal = false,
  label,
}: SuiSettlementStackGlyphProps) {
  const { w, d, slab, gap } = STACK;
  const sw = focal ? STROKE_FOCAL : STROKE;
  return (
    <g>
      {[0, 1, 2].map((i) => {
        const z = at.z + i * (slab + gap);
        const isSettled = settled && i === 2;
        const tip = isoPoint(at.x + w, at.y, z + slab / 2);
        const body = (
          <>
            <Box x={at.x} y={at.y} z={z} w={w} d={d} h={slab} top={isSettled ? IsoPalette.settled : IsoPalette.top} strokeWidth={sw} shadow={i === 0} />
            <line x1={tip[0] + 2} y1={tip[1]} x2={tip[0] + 8} y2={tip[1]} stroke={IsoPalette.line200} strokeWidth={1} />
            <Caption at={[tip[0] + 11, tip[1]]} text={labels[i]} fill={isSettled ? IsoPalette.settledInk : IsoPalette.text2} />
          </>
        );
        if (!assembling) return <g key={i}>{body}</g>;
        const style = { '--iso-drop': `${DROP}px`, animationDelay: `${i * (loop ? 0.2 : 0.18)}s` } as CSSProperties;
        return (
          <g key={i} className={loop ? 'iso-slab-loop' : 'iso-slab-in'} style={style}>
            {body}
          </g>
        );
      })}
      {label && <LabelPlane anchor={isoPoint(at.x + w / 2, at.y + d / 2, at.z + STACK_HEIGHT)} text={label} />}
    </g>
  );
}

export interface SuiSettlementStackProps extends IsoModuleProps, SuiSettlementStackGlyphProps {}

export function SuiSettlementStack({ className, size, label, ariaLabel, decorative, at = ORIGIN, labels = DEFAULT_LABELS, ...rest }: SuiSettlementStackProps) {
  return (
    <IsoSvg
      bounds={stackBounds(at, labels, label)}
      ariaLabel={ariaLabel ?? label ?? `Settlement stack: ${labels.join(', ')}`}
      decorative={decorative}
      className={className}
      size={size}
    >
      <SuiSettlementStackGlyph at={at} labels={labels} label={label} {...rest} />
    </IsoSvg>
  );
}

export default SuiSettlementStack;
