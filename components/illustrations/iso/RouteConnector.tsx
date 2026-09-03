/**
 * RouteConnector — a dotted isometric route between two world points with
 * three travelling dots (2.5s loop, staggered). Routes follow the iso axes:
 * along x first, then y.
 *
 * Motion is native SVG (`animateMotion`), so the module ships no animation
 * library and renders on the server. Under `prefers-reduced-motion` the CSS
 * in globals.css hides the moving group and shows static dots at thirds.
 */
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

export function RouteConnectorGlyph({ from, to, tone = 'entry', dots = 3, duration = ROUTE_DURATION }: RouteConnectorGlyphProps) {
  const pts = routePoints(from, to);
  const color = tone === 'settled' ? IsoPalette.settledInk : IsoPalette.text2;
  const track = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
  return (
    <g>
      <path d={track} fill="none" stroke={IsoPalette.line200} strokeWidth={1.5} strokeDasharray="1.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
      <g className="iso-motion">
        {Array.from({ length: dots }, (_, i) => {
          const begin = `${-(i / dots) * duration}s`;
          return (
            <circle key={i} r={2.5} fill={color}>
              <animateMotion dur={`${duration}s`} repeatCount="indefinite" begin={begin} path={track} />
              <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur={`${duration}s`} repeatCount="indefinite" begin={begin} />
            </circle>
          );
        })}
      </g>
      <g className="iso-motion-static">
        {Array.from({ length: dots }, (_, i) => {
          const [cx, cy] = pointAt(pts, (i + 0.5) / dots);
          return <circle key={i} r={2.5} cx={cx} cy={cy} fill={color} />;
        })}
      </g>
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
