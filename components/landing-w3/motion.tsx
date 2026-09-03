'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Scroll choreography, kept to one IntersectionObserver per element and one
 * class flip. Nothing here gates content: every element is authored in its
 * final state and the stylesheet only offsets it while JS and motion are
 * available, so a viewer with reduced motion, no JS or a failed hydration
 * still reads the page in full.
 */
export function Reveal({ children, delay = 0, className = '', as: Tag = 'div' }: { children: ReactNode; delay?: number; className?: string; as?: 'div' | 'section' | 'li' | 'article' }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node.classList.add('in');
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);
  return (
    // @ts-expect-error -- polymorphic tag, ref type widened deliberately
    <Tag ref={ref} data-reveal="" className={className} style={{ '--delay': `${delay}ms` } as React.CSSProperties}>
      {children}
    </Tag>
  );
}

/**
 * Marks the page as motion-capable. The stylesheet only offsets revealed
 * elements while this flag is set, so a viewer without JS — or with reduced
 * motion, where the flag is never set — gets the finished page immediately.
 */
export function MotionReady() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const root = document.querySelector('.w3');
    root?.setAttribute('data-motion', 'ready');
    return () => root?.removeAttribute('data-motion');
  }, []);
  return null;
}

/** A number that counts to its value once, then stays. The final value is the accessible text. */
export function Counter({ value, decimals = 0, prefix = '', suffix = '', className = '' }: { value: number; decimals?: number; prefix?: string; suffix?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    let frame = 0;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        io.disconnect();
        const start = performance.now();
        const run = (now: number) => {
          const t = Math.min(1, (now - start) / 900);
          const eased = 1 - (1 - t) ** 3;
          setShown(value * eased);
          if (t < 1) frame = requestAnimationFrame(run);
        };
        setShown(0);
        frame = requestAnimationFrame(run);
      },
      { threshold: 0.4 },
    );
    io.observe(node);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      {shown.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  );
}

/** Marks the flow spine so its fill and dots animate together once in view. */
export function Flow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node.classList.add('in');
      return undefined;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        node.classList.add('in');
        io.disconnect();
      }
    }, { threshold: 0.35 });
    io.observe(node);
    return () => io.disconnect();
  }, []);
  return (
    <ol ref={ref} className="w3-flow">
      <span className="w3-flow__fill" aria-hidden="true" />
      {children}
    </ol>
  );
}
