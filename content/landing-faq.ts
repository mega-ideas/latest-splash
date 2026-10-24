import { pricingLine } from '../lib/fees/copy.ts';
import { LAUNCH_SCHEDULE, type FeeSchedule } from '../lib/fees/schedule.ts';

/**
 * The questions, shared with the FAQ JSON-LD in app/page.tsx so both say the
 * same thing. The cost answer is Splash's pricing line, rendered from
 * `schedule` (A1 §2.7): the page passes the schedule in force.
 */
export function landingFaq(schedule: FeeSchedule): Array<{ q: string; a: string }> {
  return [
    {
      q: 'Does Splash hold a money-services licence?',
      a: 'Not yet. Splash is not yet a licensed money-services business. Today it runs the software that prepares, approves and records a payment, and partners of record carry out the regulated steps. The trust page says who does what.',
    },
    {
      q: 'What does a payment cost?',
      a: `Splash's fee depends on where the payment goes. ${pricingLine(schedule)} The exchange rate is quoted when you send and written on the record.`,
    },
    {
      q: 'How long does it take?',
      a: 'The settlement step is final in under a second. Delivery to a Philippine bank or wallet depends on the local rail, and the quote shows the expected time before you approve.',
    },
    {
      q: 'Does the assistant move money?',
      a: 'No. The assistant can prepare a payment and suggest a batch. A person approves every payment, and nothing moves without that approval.',
    },
    {
      q: 'Can Splash hold a balance for me or my supplier?',
      a: 'Not yet. Holding customer funds needs a money-broking licence Splash does not hold. Today Splash pays out only: the supplier is paid, and nothing is kept on your behalf.',
    },
  ];
}

/** The questions on the launch schedule, the FeeConfig default at publish. */
export const LANDING_FAQ = landingFaq(LAUNCH_SCHEDULE);
