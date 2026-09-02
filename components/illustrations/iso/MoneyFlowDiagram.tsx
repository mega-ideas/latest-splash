'use client';

/**
 * MoneyFlowDiagram — BusinessBlock → SplashNode → SuiSettlementStack →
 * PartnerTowers (one per corridor) → BankBlock, joined by RouteConnectors
 * (entry tone before the stack, settled tone after it).
 *
 * Export sizes: 320 (mobile: crop="focal", or vertical), 640 (tablet:
 * vertical), 1280 (desktop: full horizontal).
 */
import type { ReactNode } from 'react';
import { BANK_BLOCK, bankBlockBounds, BankBlockGlyph } from './BankBlock';
import { BUSINESS_BLOCK, businessBlockBounds, BusinessBlockGlyph } from './BusinessBlock';
import { GRID, unionBounds, type Bounds, type Vec3 } from './iso';
import { PARTNER_TOWER, partnerTowerBounds, PartnerTowerGlyph } from './PartnerTower';
import { IsoSvg, type IsoModuleProps } from './primitives';
import { routeBounds, RouteConnectorGlyph } from './RouteConnector';
import { splashNodeBounds, SplashNodeGlyph } from './SplashNode';
import { STACK, stackBounds, SuiSettlementStackGlyph } from './SuiSettlementStack';

export interface Corridor {
  currency: string;
  country: string;
}

export interface MoneyFlowLabels {
  business?: string;
  node?: string;
  bank?: string;
  stack?: readonly [string, string, string];
}

export interface MoneyFlowDiagramProps extends IsoModuleProps {
  mode?: 'send' | 'batch';
  corridors?: Corridor[];
  settled?: boolean;
  /** Stack the same nodes top → bottom (mobile / narrow columns). */
  vertical?: boolean;
  crop?: 'focal' | 'full';
  labels?: MoneyFlowLabels;
}

const H_STEP = 14 * GRID;
const V_STEP = 12 * GRID;
const FAN = 9 * GRID;
const DEFAULT_CORRIDORS: Corridor[] = [
  { currency: 'PHP', country: 'PH' },
  { currency: 'IDR', country: 'ID' },
];

interface Node {
  key: string;
  center: Vec3;
  bounds: Bounds;
  render: () => ReactNode;
}

function slot(i: number, vertical: boolean, offset = 0): Vec3 {
  const s = i * (vertical ? V_STEP : H_STEP);
  return vertical ? { x: s + offset, y: s - offset, z: 0 } : { x: s + offset, y: -s + offset, z: 0 };
}

function corner(c: Vec3, w: number, d: number): Vec3 {
  return { x: c.x - w / 2, y: c.y - d / 2, z: 0 };
}

export function MoneyFlowDiagram({
  className,
  size,
  label,
  ariaLabel,
  decorative,
  mode = 'send',
  corridors = DEFAULT_CORRIDORS,
  settled = false,
  vertical = false,
  crop = 'full',
  labels = {},
}: MoneyFlowDiagramProps) {
  const nodeLabel = labels.node ?? 'splash';
  const name = ariaLabel ?? label ?? `Money flow (${mode}) to ${corridors.map((c) => c.country).join(', ')}`;

  if (crop === 'focal') {
    return (
      <IsoSvg bounds={splashNodeBounds(undefined, nodeLabel)} ariaLabel={name} decorative={decorative} className={className} size={size}>
        <SplashNodeGlyph label={nodeLabel} focal />
      </IsoSvg>
    );
  }

  const bizLabel = labels.business ?? (mode === 'batch' ? 'batch' : 'business');
  const bankLabel = labels.bank ?? 'bank';
  const entryDots = mode === 'batch' ? 5 : 3;

  const biz = slot(0, vertical);
  const node = slot(1, vertical);
  const stack = slot(2, vertical);
  const bank = slot(4, vertical);
  const towers = corridors.map((c, k) => ({ c, center: slot(3, vertical, (k - (corridors.length - 1) / 2) * FAN) }));

  const bizAt = corner(biz, BUSINESS_BLOCK.w, BUSINESS_BLOCK.d);
  const stackAt = corner(stack, STACK.w, STACK.d);
  const bankAt = corner(bank, BANK_BLOCK.w, BANK_BLOCK.d);

  const nodes: Node[] = [
    { key: 'biz', center: biz, bounds: businessBlockBounds(bizAt, bizLabel), render: () => <BusinessBlockGlyph at={bizAt} label={bizLabel} /> },
    { key: 'node', center: node, bounds: splashNodeBounds(node, nodeLabel), render: () => <SplashNodeGlyph at={node} label={nodeLabel} focal /> },
    { key: 'stack', center: stack, bounds: stackBounds(stackAt, labels.stack), render: () => <SuiSettlementStackGlyph at={stackAt} labels={labels.stack} settled={settled} /> },
    ...towers.map(({ c, center }) => {
      const at = corner(center, PARTNER_TOWER.w, PARTNER_TOWER.d);
      return { key: `tower-${c.country}`, center, bounds: partnerTowerBounds(at, c.currency, c.country), render: () => <PartnerTowerGlyph at={at} currency={c.currency} label={c.country} /> };
    }),
    { key: 'bank', center: bank, bounds: bankBlockBounds(bankAt, bankLabel), render: () => <BankBlockGlyph at={bankAt} label={bankLabel} /> },
  ];
  // Painter's order: farther objects (smaller x+y) first.
  const ordered = [...nodes].sort((a, b) => a.center.x + a.center.y - (b.center.x + b.center.y));

  const routes = [
    { key: 'r-biz', from: biz, to: node, tone: 'entry' as const, dots: entryDots },
    { key: 'r-node', from: node, to: stack, tone: 'entry' as const, dots: entryDots },
    ...towers.flatMap(({ c, center }) => [
      { key: `r-in-${c.country}`, from: stack, to: center, tone: 'settled' as const, dots: 3 },
      { key: `r-out-${c.country}`, from: center, to: bank, tone: 'settled' as const, dots: 3 },
    ]),
  ];

  const bounds = unionBounds(...nodes.map((n) => n.bounds), ...routes.map((r) => routeBounds(r.from, r.to)));

  return (
    <IsoSvg bounds={bounds} pad={2 * GRID} ariaLabel={name} decorative={decorative} className={className} size={size}>
      {routes.map(({ key, ...r }) => (
        <RouteConnectorGlyph key={key} {...r} />
      ))}
      {ordered.map((n) => (
        <g key={n.key}>{n.render()}</g>
      ))}
    </IsoSvg>
  );
}

export default MoneyFlowDiagram;
