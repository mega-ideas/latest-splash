import Link from 'next/link';

import PostureFooter from '@/components/brand/PostureFooter';
import Wordmark from '@/components/brand/Wordmark';
import { brand } from '@/lib/brand';

import { container } from './ui';

const COLUMNS = [
  { title: 'Product', links: [['Pricing', '/pricing'], ['Rates', '/rates'], ['Docs', '/docs'], ['Sandbox', '/sandbox']] },
  { title: 'Company', links: [['Trust & compliance', '/trust'], ['Roadmap', '/roadmap'], ['Support', `mailto:${brand.supportEmail}`]] },
];

/** Footer (§3.11): posture line, /trust, env badge. No social noise. */
export default function Footer() {
  return (
    <footer className="border-t border-[var(--divider)] bg-[var(--surface)] py-12">
      <div className={`${container} grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]`}>
        <div>
          <Wordmark size={28} />
          <p className="mt-4 max-w-[40ch] text-[14px] leading-[1.55] text-[var(--text-2)]">Send USD across Southeast Asia in minutes. Settled atomically on Sui, proven on-chain.</p>
        </div>
        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h2 className="font-mono text-[12px] uppercase tracking-[0.1em] text-[var(--text-muted)]">{column.title}</h2>
            <ul className="mt-3 grid gap-2">
              {column.links.map(([label, href]) => (
                <li key={href}>
                  <Link href={href} className="text-[14px] text-[var(--text-2)] underline-offset-4 hover:text-[var(--text)] hover:underline">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className={`${container} mt-10 border-t border-[var(--divider)] pt-6 text-[13px] text-[var(--text-2)]`}>
        <PostureFooter />
        <p className="mt-3 text-[12px] text-[var(--text-muted)]">{brand.copyright}</p>
      </div>
    </footer>
  );
}
