'use client';

import { useRef, type ReactNode } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

import { cn } from '@/lib/utils';

gsap.registerPlugin(useGSAP);

type DashPageHeaderProps = {
  kicker: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

/**
 * Shared page header for every dashboard route: mono-gold kicker, extruded
 * display title, optional description and right-aligned actions.
 */
export default function DashPageHeader({ kicker, title, description, actions, className }: DashPageHeaderProps) {
  const ref = useRef<HTMLElement>(null);

  // Transform-only entrance: opacity reveals can freeze invisible when the
  // dashboard streams into a display:none wrapper, so we only translate.
  useGSAP(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const targets = ref.current ? Array.from(ref.current.children) : [];
    if (targets.length === 0) return;
    gsap.from(targets, {
      y: 16,
      duration: 0.55,
      ease: 'power3.out',
      stagger: 0.07,
      clearProps: 'transform',
    });
  }, { scope: ref });

  return (
    <header ref={ref} className={cn('flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div>
        <span className="dash-kicker">{kicker}</span>
        <h1 className="dash-title mt-2">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[13px] font-medium text-[#326273]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
