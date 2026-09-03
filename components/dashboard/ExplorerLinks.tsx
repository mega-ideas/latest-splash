import { ExternalLink } from 'lucide-react';

import { cn } from '@/lib/utils';

/** Paired SuiScan / SuiVision links for a transaction digest. */
export default function ExplorerLinks({ digest, className }: { digest: string; className?: string }) {
  const links = [
    { label: 'SuiScan', href: `https://suiscan.xyz/testnet/tx/${digest}` },
    { label: 'SuiVision', href: `https://testnet.suivision.xyz/txblock/${digest}` },
  ];

  return (
    <div className={cn('flex shrink-0 gap-2', className)}>
      {links.map(({ label, href }) => (
        <a
          key={label}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-lg bg-[#5C9EAD]/10 px-2.5 py-1.5 text-[13px] font-medium text-[var(--info)] transition-colors hover:bg-[#5C9EAD]/20"
        >
          <ExternalLink size={11} /> {label}
        </a>
      ))}
    </div>
  );
}
