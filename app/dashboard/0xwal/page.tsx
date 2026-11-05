import { redirect } from 'next/navigation';

/** The invoice loop merged into the Invoices page — keep old deep links working. */
export default function OxWalPage() {
  redirect('/dashboard/invoices?view=pay');
}
