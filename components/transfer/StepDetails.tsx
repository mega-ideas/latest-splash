'use client';

import { ArrowLeft, ArrowRight } from 'lucide-react';

import DetailsBank from './DetailsBank';
import DetailsBusiness from './DetailsBusiness';
import DetailsWallet from './DetailsWallet';
import { PrimaryButton, QuietButton } from './ui';
import type { StepProps } from './flow';

const TITLES = {
  bank: ['Who receives the money?', "A supplier's business bank account. They are paid in local currency."],
  splash_business: ['Which business on Splash?', 'Search by registered name. There is no account number to type.'],
  wallet: ['Where does the USDC go?', 'An address you save once and check once. Payments on Sui are final.'],
} as const;

/** Step 2, "Recipient details": the form depends on step 1, so only what applies is asked. */
export default function StepDetails(props: StepProps) {
  const { flow, back, next } = props;
  const kind = flow.payeeType ?? 'bank';
  const [title, hint] = TITLES[kind];
  const blocked = flow.chosen?.kind === 'recipient' ? flow.chosen.blocked : null;
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[22px] font-extrabold text-[#0c3e48]">{title}</h2>
        <p className="mt-1 text-sm text-[#326273]">{hint}</p>
      </div>
      {kind === 'bank' ? <DetailsBank flow={flow} patch={props.patch} ctx={props.ctx} beneficiaries={props.beneficiaries} reload={props.reload} /> : null}
      {kind === 'splash_business' ? <DetailsBusiness flow={flow} patch={props.patch} /> : null}
      {kind === 'wallet' ? <DetailsWallet flow={flow} patch={props.patch} recipients={props.recipients} reload={props.reload} /> : null}
      <div className="flex flex-col-reverse gap-2 border-t border-[#326273]/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <QuietButton type="button" onClick={back}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </QuietButton>
        <PrimaryButton type="button" disabled={!flow.chosen || Boolean(blocked)} onClick={next}>
          Continue to amount
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </PrimaryButton>
      </div>
    </div>
  );
}
