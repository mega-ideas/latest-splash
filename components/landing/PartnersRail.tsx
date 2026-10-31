import { LANDING_RAILS } from '@/content/rails';

/**
 * The strip under the product section (v2 brief section 6).
 *
 * Partners appear here only once their agreements are signed: the page reads
 * SIGNED_PARTNERS on the server (lib/server/signed-partners.ts) and hands
 * down the signed ones, names and roles. While that list is empty, which is
 * the default, the strip shows the rails and standards every payment runs on
 * instead (content/rails.ts). Nothing in this file types a company's name.
 */
export type SignedPartner = { name: string; role: string };

export default function PartnersRail({ signed }: { signed: readonly SignedPartner[] }) {
  const showPartners = signed.length > 0;
  const items = showPartners ? signed : LANDING_RAILS;
  return (
    <section className="iso-partner-rail pr-rail" aria-labelledby="partners-title">
      <div className="iso-shell">
        <div className="pr-intro">
          <h2 id="partners-title">{showPartners ? 'Partners of record' : 'The rails underneath'}</h2>
          <p>
            {showPartners
              ? 'The companies that pay out and verify, each under its own agreement with Splash.'
              : 'What a payment settles on, pays in, records with and lands through.'}
          </p>
        </div>
        <ul className="pr-list">
          {items.map((item) => (
            <li key={item.name}>
              <strong>{item.name}</strong>
              <span>{item.role}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
