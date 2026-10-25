/**
 * A plain-text PDF, written by hand (v2 §4.6).
 *
 * The controls-evidence export and the sender-declaration pack are documents
 * a bank partner or an exchange files. They need to open in any reader and
 * say exactly what the JSON beside them says, nothing more. A layout engine
 * is not needed for that, and a dependency that renders HTML would be one
 * more thing that can put text on the page the JSON does not hold.
 *
 * What this writes: PDF 1.4, A4 pages, the standard Helvetica and
 * Helvetica-Bold fonts (every reader has them, nothing is embedded), lines
 * wrapped to the page width, a page break when a page is full. Text is
 * reduced to printable ASCII: accents are dropped (NFKD) and anything else
 * becomes `?`, because the standard fonts have no glyphs for it and a
 * silently missing character in an evidence document is worse than a
 * visible placeholder.
 */

export type PdfLine =
  | { kind: 'title'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string }
  /** A label and its value on one line ("Label: value"), the value wrapped under it. */
  | { kind: 'field'; label: string; value: string }
  | { kind: 'gap' };

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 56;
const BODY_SIZE = 10;
const LEADING = 14;
/** Helvetica at 10pt averages about 5.5pt per character; wrap conservatively. */
const CHARS_PER_LINE = 88;

/** Printable ASCII only: accents dropped, anything else `?`. */
export function pdfSafeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e]/g, '?');
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Break a line into pieces no longer than `width`, at spaces where it can. */
export function wrapText(text: string, width = CHARS_PER_LINE): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

type Placed = { font: 'F1' | 'F2'; size: number; text: string };

function layout(lines: PdfLine[]): Placed[] {
  const placed: Placed[] = [];
  for (const line of lines) {
    if (line.kind === 'gap') {
      placed.push({ font: 'F1', size: BODY_SIZE, text: '' });
    } else if (line.kind === 'title') {
      for (const piece of wrapText(pdfSafeText(line.text), 60)) placed.push({ font: 'F2', size: 14, text: piece });
    } else if (line.kind === 'heading') {
      placed.push({ font: 'F1', size: BODY_SIZE, text: '' });
      for (const piece of wrapText(pdfSafeText(line.text))) placed.push({ font: 'F2', size: 11, text: piece });
    } else if (line.kind === 'text') {
      for (const piece of wrapText(pdfSafeText(line.text))) placed.push({ font: 'F1', size: BODY_SIZE, text: piece });
    } else {
      const label = pdfSafeText(line.label);
      const value = pdfSafeText(line.value);
      const first = `${label}: ${value}`;
      if (first.length <= CHARS_PER_LINE) {
        placed.push({ font: 'F1', size: BODY_SIZE, text: first });
      } else {
        placed.push({ font: 'F1', size: BODY_SIZE, text: `${label}:` });
        for (const piece of wrapText(value, CHARS_PER_LINE - 4)) placed.push({ font: 'F1', size: BODY_SIZE, text: `    ${piece}` });
      }
    }
  }
  return placed;
}

/** The lines as a PDF document. Deterministic: the same lines give the same bytes. */
export function renderTextPdf(lines: PdfLine[], opts: { footer?: string } = {}): Uint8Array {
  const placed = layout(lines);
  const perPage = Math.floor((PAGE_H - 2 * MARGIN - LEADING) / LEADING);
  const pages: Placed[][] = [];
  for (let i = 0; i < placed.length; i += perPage) pages.push(placed.slice(i, i + perPage));
  if (pages.length === 0) pages.push([]);

  const footer = opts.footer ? pdfSafeText(opts.footer) : '';
  const streams = pages.map((page, index) => {
    const ops: string[] = [];
    let y = PAGE_H - MARGIN;
    for (const p of page) {
      if (p.text) ops.push(`BT /${p.font} ${p.size} Tf ${MARGIN} ${y} Td (${escapePdfString(p.text)}) Tj ET`);
      y -= LEADING;
    }
    const foot = `${footer ? `${footer}  ` : ''}Page ${index + 1} of ${pages.length}`;
    ops.push(`BT /F1 8 Tf ${MARGIN} ${MARGIN / 2} Td (${escapePdfString(foot)}) Tj ET`);
    return ops.join('\n');
  });

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, then a page and its stream per page.
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  streams.forEach((stream, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}
