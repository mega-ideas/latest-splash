/**
 * ReceiptToken — a small receipt card floating at elevation 1, with a mono
 * digest-fragment label on the plane above it.
 */
import { boxBounds, ELEVATION, GRID, IsoPalette, isoPoint, labelRoom, ORIGIN, polyPath, topCenter, type Bounds, type Vec3 } from './iso';
import { Box, IsoSvg, LabelPlane, type IsoModuleProps } from './primitives';

export const RECEIPT_TOKEN = { w: 4 * GRID, d: 5 * GRID, h: GRID / 2, float: ELEVATION[1] } as const;

export interface ReceiptTokenGlyphProps {
  /** Ground position; the card floats `RECEIPT_TOKEN.float` above `at.z`. */
  at?: Vec3;
  /** Digest fragment shown on the label plane, e.g. "0x3f9a…c21e". */
  digest?: string;
  label?: string;
}

export function receiptTokenBounds(at: Vec3 = ORIGIN, digest?: string): Bounds {
  const { w, d, h, float } = RECEIPT_TOKEN;
  return labelRoom(boxBounds(at.x, at.y, at.z, w, d, float + h), digest);
}

export function ReceiptTokenGlyph({ at = ORIGIN, digest, label }: ReceiptTokenGlyphProps) {
  const { w, d, h, float } = RECEIPT_TOKEN;
  const { x, y } = at;
  const z = at.z + float;
  const top = z + h;
  const lines = [1.5, 2.5, 3.5].map((k) => {
    const a = isoPoint(x + GRID * 0.75, y + GRID * k, top);
    const b = isoPoint(x + GRID * (k === 3.5 ? 2 : 3.25), y + GRID * k, top);
    return `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`;
  });
  const mark = polyPath([
    isoPoint(x + GRID * 0.75, y + GRID * 0.5, top),
    isoPoint(x + GRID * 1.5, y + GRID * 0.5, top),
    isoPoint(x + GRID * 1.5, y + GRID * 1, top),
    isoPoint(x + GRID * 0.75, y + GRID * 1, top),
  ]);
  const text = digest ?? label;
  return (
    <g>
      <path
        d={polyPath([isoPoint(x + 2, y + 2, at.z), isoPoint(x + w + 2, y + 2, at.z), isoPoint(x + w + 2, y + d + 2, at.z), isoPoint(x + 2, y + d + 2, at.z)])}
        fill={IsoPalette.shadow}
      />
      <Box x={x} y={y} z={z} w={w} d={d} h={h} top={IsoPalette.side} shadow={false}>
        <path d={mark} fill={IsoPalette.brand} />
        <path d={lines.join(' ')} fill="none" stroke={IsoPalette.line200} strokeWidth={1.5} strokeLinecap="round" />
      </Box>
      {text && <LabelPlane anchor={topCenter(x, y, z, w, d, h)} text={text} />}
    </g>
  );
}

export interface ReceiptTokenProps extends IsoModuleProps, ReceiptTokenGlyphProps {}

export function ReceiptToken({ className, size, label, ariaLabel, decorative, at = ORIGIN, digest }: ReceiptTokenProps) {
  return (
    <IsoSvg
      bounds={receiptTokenBounds(at, digest ?? label)}
      ariaLabel={ariaLabel ?? (digest ? `Receipt ${digest}` : label ?? 'Receipt')}
      decorative={decorative}
      className={className}
      size={size}
    >
      <ReceiptTokenGlyph at={at} digest={digest} label={label} />
    </IsoSvg>
  );
}

export default ReceiptToken;
