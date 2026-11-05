'use client';

import { BadgeCheck } from 'lucide-react';

import { Modal } from './ui';

const STEPS = [
  { title: 'You choose who you’re paying', body: 'A business bank account, a business on Splash, or a Sui wallet address.' },
  { title: 'Splash checks the recipient', body: 'A bank account is checked with the bank before it is saved, and must match the name you give. A wallet address is screened against sanctions lists.' },
  { title: 'The money comes from your Splash Wallet', body: 'Your business holds it, and Splash has no key to it. If it is short, you top up from a source you have already verified, and your draft waits.' },
  { title: 'Your approvers sign', body: 'The fee is fixed at what you were shown. Your owners sign on their own devices. A staff member whose spending rule covers the payment signs it alone with their own passkey; anything outside the rule goes to an owner. A bank payout’s rate is held for a few minutes.' },
  { title: 'One Sui transaction pays and records it', body: 'The payment, its record and its receipt happen together, or not at all. For a bank payout, our payout partner then credits the account by InstaPay, PESONet or BI-FAST.' },
];

const RECEIPT = ['Receipt number', 'What the payee received, and what you paid', 'Splash’s fee, and the payout partner’s own fee if there is one', 'The rate, for a bank payout', 'Who paid and who approved', 'The Sui transaction, with a link to check it'];

/** "How it works": a pop-up over a blurred backdrop, steps 1 to 5 and the on-chain receipt. Nothing in it is a number Splash has not charged. */
export default function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="One payment, start to finish" eyebrow="How it works" wide>
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
      <section aria-labelledby="hiw-receipt" className="mt-6 rounded-2xl border border-[#326273]/15 bg-white p-4">
        <p className="font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-[#145d6a]">The receipt</p>
        <h3 id="hiw-receipt" className="mt-1 flex items-center gap-2 text-base font-extrabold text-[#0c3e48]">
          Proof you can hand to your supplier or accountant
          <BadgeCheck className="h-4 w-4 text-[#145d6a]" aria-hidden="true" />
        </h3>
        <ul className="mt-3 grid gap-x-6 gap-y-1.5 text-sm text-[#1F4452] sm:grid-cols-2">
          {RECEIPT.map((line) => (
            <li key={line} className="flex gap-2"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#0d6370]" />{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] leading-5 text-[#326273]">Anyone with the link can look the payment up on Sui without signing in.</p>
      </section>
    </Modal>
  );
}
