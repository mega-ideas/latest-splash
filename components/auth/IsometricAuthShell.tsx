import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, Check, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

type IsometricAuthShellProps = {
  children: ReactNode;
  eyebrow: string;
  title: string;
  description: string;
  art: string;
  artAlt: string;
  visualTitle: string;
  visualCopy: string;
};

const proofPoints = [
  'Atomic settlement on Sui',
  'Access-controlled records on Walrus',
  'Built-in KYB and audit trail',
];

export default function IsometricAuthShell({
  children,
  eyebrow,
  title,
  description,
  art,
  artAlt,
  visualTitle,
  visualCopy,
}: IsometricAuthShellProps) {
  return (
    <main className="iso-auth">
      <header className="iso-auth-header">
        <Link href="/" className="iso-auth-back">
          <ArrowLeft aria-hidden="true" />
          Back to landing page
        </Link>
        <Link href="/" className="iso-brand" aria-label="Splash Finance home">
          <Image src="/splash-main-icon.png" alt="" width={48} height={47} className="h-auto w-[38px]" priority />
          <span>
            <strong>Splash Finance</strong>
            <small>USD settlement infrastructure</small>
          </span>
        </Link>
        <span className="iso-auth-secure"><LockKeyhole aria-hidden="true" /> Secure workspace</span>
      </header>

      <section className="iso-auth-shell">
        <aside className="iso-auth-visual">
          <div className="iso-auth-visual-copy">
            <p>{visualTitle}</p>
            <h2>{visualCopy}</h2>
          </div>
          <div className="iso-auth-art">
            <div className="iso-auth-art-shadow" aria-hidden="true" />
            <Image src={art} alt={artAlt} width={1448} height={1086} priority />
          </div>
          <div className="iso-auth-proof">
            {proofPoints.map((point) => (
              <span key={point}><Check aria-hidden="true" /> {point}</span>
            ))}
          </div>
          <div className="iso-auth-anchor">
            <ShieldCheck aria-hidden="true" />
            <span>
              <small>Session protection</small>
              <strong>Encrypted end to end</strong>
            </span>
          </div>
        </aside>

        <section className="iso-auth-form-panel">
          <div className="iso-auth-form-heading">
            <p>{eyebrow}</p>
            <h1>{title}</h1>
            <span>{description}</span>
          </div>
          {children}
        </section>
      </section>
    </main>
  );
}
