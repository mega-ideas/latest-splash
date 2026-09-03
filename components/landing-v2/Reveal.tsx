'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Scroll reveal without a motion library: an IntersectionObserver adds one
 * class, CSS does the 400ms / 12px lift once (`.lv2-reveal` in globals.css),
 * and `prefers-reduced-motion` collapses it to an opacity fade. Before
 * hydration the content is visible, so nothing depends on JavaScript.
 */
export default function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    node.classList.add('lv2-reveal');
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            node.classList.add('is-in');
            observer.disconnect();
          }
        }
      },
      { rootMargin: '-10% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={cn(className)} style={delay ? { transitionDelay: `${delay}s` } : undefined}>
      {children}
    </div>
  );
}
