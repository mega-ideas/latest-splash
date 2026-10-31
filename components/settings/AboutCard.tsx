import { ShieldCheck } from 'lucide-react';

import { ABOUT } from '@/lib/settings-page/about';
import { Card } from '@/components/wallet/parts';

/** How Splash operates: what it is and is not, in plain words (lib/settings-page/about.ts). */
export default function AboutCard() {
  return (
    <Card id="about" title="How Splash operates">
      <p className="flex items-center gap-2 text-[13px] text-[#326273]"><ShieldCheck className="h-4 w-4 shrink-0 text-[var(--info)]" aria-hidden="true" />The plain-language position, without over-claiming.</p>
      <dl className="mt-4 grid gap-3 md:grid-cols-2">
        {ABOUT.map((item) => (
          <div key={item.label} className="rounded-2xl border border-[#326273]/10 bg-[#F6F0ED] p-4">
            <dt className="text-sm font-extrabold text-[#0c3e48]">{item.label}</dt>
            <dd className="mt-1.5 text-[13px] leading-5 text-[#1F4452]">{item.text}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
