import { redirect } from 'next/navigation';

/**
 * Where every governance alert sends an owner (lib/server/governance-events.ts
 * REVIEW_PATH): "Review spending rules and allowances". The rules are summarised
 * on the Wallet page, so the link lands there.
 */
export default function SpendingRulesPage() {
  redirect('/dashboard/wallet#spending-rules');
}
