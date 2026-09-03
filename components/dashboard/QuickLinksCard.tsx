import Link from 'next/link';
import { ChevronRight, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export type QuickLink = {
  label: string;
  href: string;
  icon: LucideIcon;
  external?: boolean;
};

const rowClass =
  'flex w-full items-center justify-between rounded-lg border border-[#326273]/10 bg-white px-3 py-2.5 text-[13px] font-medium text-[#326273] transition-colors hover:border-[#5C9EAD]/40 hover:text-[var(--info)]';

/** Shared icon-row link list used in page sidebars. */
export default function QuickLinksCard({ links, className }: { links: QuickLink[]; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {links.map(({ label, href, icon: Icon, external }) => {
        const inner = (
          <>
            <span className="flex items-center gap-2">
              <Icon size={13} /> {label}
            </span>
            <ChevronRight size={13} className="text-[#326273]/30" />
          </>
        );
        return external ? (
          <a key={label} href={href} target="_blank" rel="noopener noreferrer" className={rowClass}>
            {inner}
          </a>
        ) : (
          <Link key={label} href={href} className={rowClass}>
            {inner}
          </Link>
        );
      })}
    </div>
  );
}
