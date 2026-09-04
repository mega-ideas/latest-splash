'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';

export type Guarantee = {
  label: string;
  title: string;
  copy: string;
  meta: string;
  plate: string;
  plateAlt: string;
  /* Multiplier that makes this plate's DRAWN INK the same width as the others.
     Measured, not guessed: each PNG's alpha bounding box was sampled, then run
     through the stage's object-fit:contain arithmetic. The three assets fill
     64.6% / 83.8% / 68.9% of their own frames, so at equal frame size they draw
     at 615 / 597 / 489px of actual ink — a 26% spread that reads as an
     unintended zoom when one crossfades into the next. See the commit for the
     measurement script. */
  fit: number;
};

/* The dwell is deliberately not a constant here. It lives in CSS as
   --iso-dwell, because the progress rail's animation IS the timer: the advance
   fires on its animationend. A JS duration alongside it would be a second
   source of truth that silently drifts from the one the reader can see. */

export default function GuaranteeSequence({ items }: { items: Guarantee[] }) {
  const [index, setIndex] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [tabVisible, setTabVisible] = useState(true);
  /* null until the media query has been read on the client, so the server and
     the first client paint agree. */
  const [reduced, setReduced] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /* Registered unconditionally and handling BOTH directions. An earlier version
     bailed out before subscribing, so turning reduced motion off mid-session
     left the stage permanently empty. */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const onVis = () => setTabVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* Focus is deliberately NOT a hold source. It was, and it made the Pause
     button unusable: focusing the button held the sequence, so the control
     could never report or produce a running state. The button is the WCAG
     2.2.2 mechanism; hover is a convenience on top of it. */
  const held = userPaused || hovered || !onScreen || !tabVisible;

  const advance = useCallback(
    (event: React.AnimationEvent<HTMLDivElement>) => {
      if (event.animationName !== 'iso-guarantee-dwell') return;
      setIndex((i) => (i + 1) % items.length);
    },
    [items.length],
  );

  const jump = (i: number) => {
    setIndex(i);
    setUserPaused(true); // an explicit choice should stay on screen
  };

  /* Reduced motion, and the pre-hydration state, both render every plate at
     once with equally weighted captions. Same information, no sequence — and
     because it is also the server render, nothing depends on JS to be legible. */
  if (reduced !== false) {
    return (
      <div className="iso-guarantee" data-mode="static">
        <div className="iso-guarantee-static">
          {items.map((g) => (
            <figure className="iso-guarantee-plate" key={g.label}>
              <Image src={g.plate} alt={g.plateAlt} width={1200} height={900} sizes="(max-width: 1100px) 90vw, 420px" />
            </figure>
          ))}
        </div>
        <hr className="iso-guarantee-rule" />
        <dl className="iso-guarantee-captions">
          {items.map((g) => (
            <div className="iso-guarantee-caption" key={g.label}>
              <dt>{g.label}</dt>
              <dd>
                <strong>{g.title}</strong>
                <p>{g.copy}</p>
                <small>{g.meta}</small>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  const active = items[index];

  return (
    <div
      className={`iso-guarantee${held ? ' is-held' : ''}`}
      data-mode="sequence"
      ref={rootRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      /* a touch tap must not leave `hovered` stuck true forever */
      onPointerCancel={() => setHovered(false)}
    >
      <div className="iso-guarantee-stage" onAnimationEnd={advance}>
        {items.map((g, i) => (
          <Image
            key={g.label}
            className={`iso-guarantee-frame${i === index ? ' is-current' : ''}`}
            style={{ '--iso-plate-fit': g.fit } as React.CSSProperties}
            src={g.plate}
            alt={i === index ? g.plateAlt : ''}
            aria-hidden={i !== index}
            width={1200}
            height={900}
            sizes="(max-width: 1100px) 92vw, 952px"
            priority={i === 0}
            loading={i === 0 ? undefined : 'lazy'}
          />
        ))}
        {/* The dwell clock is the progress rail itself, so the countdown the
            reader sees and the timing the code obeys are one object and cannot
            disagree. Holding pauses the animation, which pauses the advance. */}
        <div className="iso-guarantee-dwell" key={index} aria-hidden="true">
          <i />
        </div>
      </div>

      <div className="iso-guarantee-controls">
        <p className="iso-guarantee-status" aria-live="polite">
          {index + 1} of {items.length} — {active.label}
        </p>
        <div className="iso-guarantee-jumps">
          {items.map((g, i) => (
            <button
              type="button"
              key={g.label}
              className={`iso-guarantee-jump${i === index ? ' is-current' : ''}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => jump(i)}
            >
              <span aria-hidden="true">{i === index ? '●' : '○'}</span>
              {g.title.replace(/\.$/, '')}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="iso-guarantee-pause"
          aria-pressed={userPaused}
          onClick={() => setUserPaused((p) => !p)}
        >
          {userPaused ? 'Play' : 'Pause'}
        </button>
      </div>

      <hr className="iso-guarantee-rule" />

      {/* The list is a sibling of the figure, not inside its <figcaption>.
          Nesting it made the figure's accessible name 916 characters long. */}
      <dl className="iso-guarantee-captions">
        {items.map((g, i) => (
          <div className={`iso-guarantee-caption${i === index ? ' is-current' : ''}`} key={g.label}>
            <dt>{g.label}</dt>
            <dd>
              <strong>{g.title}</strong>
              <p>{g.copy}</p>
              <small>{g.meta}</small>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
