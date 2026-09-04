'use client';

import { useEffect, useRef, useState } from 'react';

export type CorridorRoute = {
  route: string;
  status: string;
  rail: string | null;
  missing: string | null;
  live?: boolean;
};

/**
 * The corridor board, read as a departure board.
 *
 * It flips to its values when it comes into view and then holds. Two things it
 * deliberately does NOT do, both of which a first version did:
 *
 * 1. It does not split strings into per-character spans. That is how a real
 *    split-flap is usually faked, and it destroys the cell: selecting one and
 *    pasting it produced the value followed by thirty-odd lines of loose
 *    letters, and find-in-page stopped matching. The people this page is for
 *    copy tables into spreadsheets. The text here is never split — one
 *    transform animates one wrapper per cell, and the value underneath is
 *    ordinary, selectable, findable text.
 *
 * 2. It does not roll a modelled route through "partner signed" and "testnet
 *    live" before landing on the truth. That was suggested as a way to show the
 *    ladder a route has not climbed, and it is a genuinely good idea, but it
 *    means a screenshot taken mid-flip shows "testnet live" against a corridor
 *    that is not. On this page, of all pages, that is not a risk worth the
 *    flourish. A departure board flips to the value it has; it does not cycle
 *    through other flights first. Every frame here shows each route's own
 *    true status.
 */
export default function CorridorBoard({ routes }: { routes: CorridorRoute[] }) {
  const [arrived, setArrived] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => setArrived(e.isIntersecting),
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      className={`iso-route-table-wrap${arrived ? ' is-arrived' : ''}`}
      ref={ref}
      /* the table scrolls sideways on narrow viewports, and the column that
         scrolls out of reach is the one the caption promises — so the scroll
         container has to be reachable by keyboard, not just by trackpad */
      tabIndex={0}
      role="region"
      aria-label="Corridor status board"
    >
      <table className="iso-route-table">
        <caption>Every corridor, and what each one that is not live is waiting on.</caption>
        <thead>
          <tr>
            <th scope="col">Route</th>
            <th scope="col">Status</th>
            <th scope="col">Waiting on</th>
          </tr>
        </thead>
        <tbody>
          {routes.map((row, i) => (
            <tr
              key={row.route}
              className={row.live ? 'is-live' : undefined}
              style={{ '--row': i } as React.CSSProperties}
            >
              <th scope="row">
                <span className="iso-flap">{row.route}</span>
              </th>
              <td>
                <span className="iso-flap">
                  {row.live ? <span className="iso-route-live-mark" aria-hidden="true" /> : null}
                  {row.status}
                  {row.rail ? ` on ${row.rail}` : ''}
                </span>
              </td>
              <td>
                <span className="iso-flap">
                  {row.missing ?? <span className="iso-cell-dash">&mdash;</span>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
