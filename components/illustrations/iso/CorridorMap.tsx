/**
 * CorridorMap — origin (MY) → partner corridors (PH / ID …) on one iso plane,
 * joined by settled routes. Corridor slots run north-east, then south-east,
 * then east, mirroring the region's geography.
 *
 * Export sizes: 320 (mobile: crop="focal"), 640 (tablet), 1280 (desktop).
 */
import type { ReactNode } from 'react';
import type { Corridor } from './MoneyFlowDiagram';
import { GRID, unionBounds, boxBounds, type Bounds, type Vec3 } from './iso';
import { PARTNER_TOWER, partnerTowerBounds, PartnerTowerGlyph } from './PartnerTower';
import { GridPlane, IsoSvg, type IsoModuleProps } from './primitives';
import { RouteConnectorGlyph } from './RouteConnector';
import { SPLASH_NODE, splashNodeBounds, SplashNodeGlyph } from './SplashNode';

export interface CorridorMapProps extends IsoModuleProps {
  corridors?: Corridor[];
  /** Origin label on the Splash node, e.g. "MY". */
  origin?: string;
  crop?: 'focal' | 'full';
}

const D = 10 * GRID;
const MARGIN = 6 * GRID;
const SLOTS: Vec3[] = [
  { x: 0, y: -D, z: 0 },
  { x: D, y: 0, z: 0 },
  { x: D, y: -D, z: 0 },
  { x: 2 * D, y: -2 * D, z: 0 },
];
const DEFAULT_CORRIDORS: Corridor[] = [
  { currency: 'PHP', country: 'PH' },
  { currency: 'IDR', country: 'ID' },
];

export function CorridorMap({ className, size, label, ariaLabel, decorative, corridors = DEFAULT_CORRIDORS, origin = 'MY', crop = 'full' }: CorridorMapProps) {
  const name = ariaLabel ?? label ?? `Corridors from ${origin} to ${corridors.map((c) => c.country).join(', ')}`;
  const home: Vec3 = { x: 0, y: 0, z: 0 };

  if (crop === 'focal') {
    return (
      <IsoSvg bounds={splashNodeBounds(home, origin)} ariaLabel={name} decorative={decorative} className={className} size={size}>
        <SplashNodeGlyph at={home} label={origin} focal />
      </IsoSvg>
    );
  }

  const towers = corridors.slice(0, SLOTS.length).map((c, k) => {
    const center = SLOTS[k];
    const at: Vec3 = { x: center.x - PARTNER_TOWER.w / 2, y: center.y - PARTNER_TOWER.d / 2, z: 0 };
    return { c, center, at };
  });

  const items: { key: string; depth: number; bounds: Bounds; render: () => ReactNode }[] = [
    { key: 'origin', depth: 0, bounds: splashNodeBounds(home, origin), render: () => <SplashNodeGlyph at={home} label={origin} focal /> },
    ...towers.map(({ c, center, at }) => ({
      key: `tower-${c.country}`,
      depth: center.x + center.y,
      bounds: partnerTowerBounds(at, c.currency, c.country),
      render: () => <PartnerTowerGlyph at={at} currency={c.currency} label={c.country} />,
    })),
  ];
  const ordered = [...items].sort((a, b) => a.depth - b.depth);

  const xs = [home.x - SPLASH_NODE.r, ...towers.flatMap((t) => [t.at.x, t.at.x + PARTNER_TOWER.w])];
  const ys = [home.y - SPLASH_NODE.r, home.y + SPLASH_NODE.r, ...towers.flatMap((t) => [t.at.y, t.at.y + PARTNER_TOWER.d])];
  const plane = {
    x: Math.min(...xs) - MARGIN,
    y: Math.min(...ys) - MARGIN,
    w: Math.max(...xs) - Math.min(...xs) + 2 * MARGIN,
    d: Math.max(...ys) - Math.min(...ys) + 2 * MARGIN,
  };
  const bounds = unionBounds(boxBounds(plane.x, plane.y, 0, plane.w, plane.d, 0), ...items.map((i) => i.bounds));

  return (
    <IsoSvg bounds={bounds} pad={2 * GRID} ariaLabel={name} decorative={decorative} className={className} size={size}>
      <GridPlane {...plane} />
      {towers.map(({ c, center }) => (
        <RouteConnectorGlyph key={`route-${c.country}`} from={home} to={center} tone="settled" />
      ))}
      {ordered.map((i) => (
        <g key={i.key}>{i.render()}</g>
      ))}
    </IsoSvg>
  );
}

export default CorridorMap;
