'use client';

import { BadgeCheck } from 'lucide-react';

import { Modal } from '../transfer/ui';

const STEPS = [
  { title: 'Upload your sheet', body: 'A CSV or Excel file with a recipient, an amount in USDC and a reference on each row: up to 20 payments. A recipient is someone you have already saved in Recipients, or a business on Splash by its registered name.' },
  { title: 'Splash checks every row', body: 'Each recipient is matched to your saved recipients and screened against sanctions lists, and each row gets its own answer, with the fee from Splash’s published schedule. A sheet can never add a new payee: it only names people you have saved.' },
  { title: 'Your owners approve once', body: 'The whole batch is one Sui transaction, so your owners sign it once on their own devices, each seeing every payment first. A team member can prepare a batch; an owner then starts the signatures.' },
  { title: 'The batch is sent', body: 'Once enough owners have signed, Splash sends the transaction. Every payment in it is paid, or none is: a batch is never half paid.' },
  { title: 'You get a receipt for each payment', body: 'One receipt per recipient, plus the batch total and a CSV for your accountant.' },
];

const RECEIPT = ['A receipt number for each payment', 'What each recipient received', 'Splash’s fee on each payment, as charged', 'Who approved the batch', 'The Sui transaction, with a link to check it', 'One file for your accountant'];

/** "How it works" for batch payouts: the same pop-up as Transfer, over a blurred backdrop. Nothing in it is a number Splash has not charged. */
export default function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Many payments, one approval" eyebrow="How it works" wide>
      <ol className="space-y-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3.5 rounded-xl border border-[#326273]/12 bg-white p-3.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#0c3e48] font-mono text-sm font-bold text-white" aria-hidden="true">{i + 1}</span>
            <div className="min-w-0">
              <h3 className="text-[15px] font-bold text-[#0c3e48]">{step.title}</h3>
              <p className="mt-0.5 text-sm leading-6 text-[#326273]">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <section aria-labelledby="hiw-batch-receipt" className="mt-6 rounded-2xl border border-[#326273]/15 bg-white p-4">
        <p className="font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-[#145d6a]">The receipts</p>
        <h3 id="hiw-batch-receipt" className="mt-1 flex items-center gap-2 text-base font-extrabold text-[#0c3e48]">
          Proof for every payment in the batch
          <BadgeCheck className="h-4 w-4 text-[#145d6a]" aria-hidden="true" />
        </h3>
        <ul className="mt-3 grid gap-x-6 gap-y-1.5 text-sm text-[#1F4452] sm:grid-cols-2">
          {RECEIPT.map((line) => (
            <li key={line} className="flex gap-2"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#0d6370]" />{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] leading-5 text-[#326273]">Anyone with the transaction link can look the batch up on Sui without signing in.</p>
      </section>
    </Modal>
  );
}
