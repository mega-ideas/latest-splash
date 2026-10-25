'use client';

import { Children, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * The three loops on a phone: one card at a time (v2 brief section 6, D15).
 *
 * The cards stay a swipeable scroll-snap row, but swiping is never the only
 * way through: Previous and Next buttons, a button per card, and the arrow
 * keys (plus Home and End) on the focused row all move it, and the position
 * is read out with the card's place and name, for example "1 of 3: Settle". Above 700 px the row is the desktop grid
 * again and the controls are hidden by CSS (styles/landing-v2.css .lc-controls).
 *
 * `labels` names each card, in order; `children` are the cards themselves,
 * kept direct children of `.iso-loops-grid` so the grid's own styles and
 * reveal still apply.
 */
export default function LoopCarousel({ labels, children }: { labels: readonly string[]; children: ReactNode }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const count = Children.count(children);

  // The card most in view is the current one, whichever way it got there.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof IntersectionObserver === 'undefined') return;
    const cards = Array.from(track.children) as HTMLElement[];
    const observer = new IntersectionObserver(
      (entries) => {
        // isIntersecting is true for any overlap, including a card on its way
        // out; only a card at least 60% in view is the current one.
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) setIndex(cards.indexOf(entry.target as HTMLElement));
        }
      },
      { root: track, threshold: 0.6 },
    );
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [count]);

  const go = useCallback(
    (next: number) => {
      const track = trackRef.current;
      if (!track) return;
      const target = Math.max(0, Math.min(count - 1, next));
      const card = track.children[target] as HTMLElement | undefined;
      if (!card) return;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      track.scrollTo({ left: card.offsetLeft - track.offsetLeft - 4, behavior: reduce ? 'auto' : 'smooth' });
      setIndex(target);
    },
    [count],
  );

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: count - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    go(moves[event.key]);
  }

  return (
    <div className="lc" role="region" aria-roledescription="carousel" aria-label="The three loops">
      <div
        ref={trackRef}
        className="iso-loops-grid"
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label="Loop cards. Use the left and right arrow keys to move between them."
      >
        {children}
      </div>

      <div className="lc-controls">
        <button type="button" className="lc-step" aria-label="Previous loop" disabled={index === 0} onClick={() => go(index - 1)}>
          <ChevronLeft aria-hidden="true" />
        </button>
        <div className="lc-dots">
          {labels.map((label, i) => (
            <button
              type="button"
              key={label}
              className="lc-dot"
              aria-label={`Show ${label}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => go(i)}
            >
              <span>{label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="lc-step" aria-label="Next loop" disabled={index >= count - 1} onClick={() => go(index + 1)}>
          <ChevronRight aria-hidden="true" />
        </button>
        <p className="sr-only" aria-live="polite">
          {index + 1} of {count}: {labels[index]}
        </p>
      </div>
    </div>
  );
}
