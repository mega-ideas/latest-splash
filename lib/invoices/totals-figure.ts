/* The Get paid totals (Open, Overdue, Paid this month) as one-line figures.

   A money figure is never split mid-number: "1,234,567.8" with "9" on the
   next line reads as a different amount. So the figure stays on one line and
   steps down in size by its length until it fits its tile; past what a tile
   holds at the smallest size, it is shown compact ("1,234,568T") with the full
   value kept for the title and for screen readers.

   Geist Mono (the dashboard's --font-mono) advances every glyph, digits,
   commas and points alike, by 0.6em, so a figure's width is its length times
   0.6 times its size (measured nearer 0.52; 0.6 leaves room). The widths are
   the tiles' content boxes as measured: on a phone (390x844) Open has the
   whole row and Overdue and Paid this month share the next one, up to lg;
   from lg the three share one row, narrowest at 1280 (164px) where the
   buttons join the row. */

export const MONO_ADVANCE_EM = 0.6;

export const TOTALS_PHONE = {
  /** Open: the whole first row of the totals block at 390px. */
  fullRowPx: 330,
  /** Overdue and Paid this month: half of the second row at 390px. */
  halfRowPx: 150,
} as const;

export const TOTALS_WIDE = {
  /** The narrowest tile from sm up: lg, three in a row, at 1280px with the buttons beside them. */
  narrowestPx: 160,
} as const;

/** Phone size (px) and the literal Tailwind classes for it and for sm and up. */
const STEPS = [
  { phonePx: 15, widePx: 18, className: 'text-[15px] sm:text-lg' },
  { phonePx: 14, widePx: 16, className: 'text-[14px] sm:text-base' },
  { phonePx: 13, widePx: 15, className: 'text-[13px] sm:text-[15px]' },
  { phonePx: 12, widePx: 14, className: 'text-[12px] sm:text-[14px]' },
] as const;

export type TotalsFigure = {
  /** What is shown. The full value unless it is too long for any step. */
  display: string;
  /** The whole figure, always kept (title and screen readers). */
  full: string;
  phonePx: number;
  /** The size from sm up. */
  widePx: number;
  className: string;
};

export function figureWidthPx(text: string, px: number): number {
  return text.length * MONO_ADVANCE_EM * px;
}

export function figureFits(figure: Pick<TotalsFigure, 'display' | 'phonePx'>, widthPx: number, px: number = figure.phonePx): boolean {
  return figureWidthPx(figure.display, px) <= widthPx;
}

function compact(full: string): string {
  const n = Number(full.replace(/,/g, ''));
  if (!Number.isFinite(n)) return full;
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
}

/** Sized for the narrowest tile it can sit in, on a phone and from sm up. */
export function totalsFigure(full: string): TotalsFigure {
  for (const step of STEPS) {
    if (figureWidthPx(full, step.phonePx) <= TOTALS_PHONE.halfRowPx && figureWidthPx(full, step.widePx) <= TOTALS_WIDE.narrowestPx) {
      return { display: full, full, phonePx: step.phonePx, widePx: step.widePx, className: step.className };
    }
  }
  const smallest = STEPS[STEPS.length - 1];
  return { display: compact(full), full, phonePx: smallest.phonePx, widePx: smallest.widePx, className: smallest.className };
}
