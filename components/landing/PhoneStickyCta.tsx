'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';

/**
 * The phone landing's sticky bottom CTA (v2 brief D15, section 6). It shows
 * once the hero, with its own button, has scrolled away, and steps aside
 * while any other "Open payment desk" button is on screen (the product
 * section's, the calculator's, the closing CTA's) or the footer is, so
 * there is never a second copy of the same button in view. CSS shows it on phones only
 * (styles/landing-v2.css .ps-cta), floating
 * clear of the home indicator (safe-area-inset-bottom).
 *
 * Visibility comes from IntersectionObserver, not a scroll listener.
 */
/** Everything on the landing that carries its own "Open payment desk", plus the footer. */
export const STEP_ASIDE_SELECTOR = '.pv-actions, .pv-send, .iso-final, .iso-footer';

export default function PhoneStickyCta() {
  const [heroVisible, setHeroVisible] = useState(true);
  const [endVisible, setEndVisible] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const hero = document.getElementById('cinematic');
    const ends = [...document.querySelectorAll(STEP_ASIDE_SELECTOR)];
    const seen = new Map<Element, boolean>();

    const heroObserver = new IntersectionObserver(([entry]) => setHeroVisible(entry.isIntersecting), { rootMargin: '0px 0px -40% 0px' });
    const endObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) seen.set(entry.target, entry.isIntersecting);
      setEndVisible([...seen.values()].some(Boolean));
    });
    if (hero) heroObserver.observe(hero);
    ends.forEach((el) => endObserver.observe(el));
    return () => {
      heroObserver.disconnect();
      endObserver.disconnect();
    };
  }, []);

  const visible = !heroVisible && !endVisible;

  return (
    <div className={`ps-cta${visible ? ' is-visible' : ''}`} aria-hidden={!visible}>
      <Link href="/signup" className="ps-cta-button" tabIndex={visible ? undefined : -1}>
        Open payment desk
        <ArrowRight aria-hidden="true" />
      </Link>
      <Link href="/login" className="ps-cta-login" tabIndex={visible ? undefined : -1}>
        Log in
      </Link>
    </div>
  );
}
