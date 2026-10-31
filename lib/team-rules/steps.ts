/**
 * Giving or changing a spending rule one question at a time (v2 §4.2, brief
 * 5.10: "one question per screen" on a phone). The steps, what each asks, and
 * how a step is checked before the next is shown. The body that finally goes
 * to the route is still made, and checked whole, by `ruleRequest`
 * (lib/team-rules/form.ts); a step only says its own part of that check, so a
 * person is never walked through six screens to a refusal. Pure and
 * client-safe.
 */
import { ruleRequest, type RuleBody, type RuleForm } from './form.ts';

export type StepId = 'who' | 'per_payment' | 'cap' | 'lifetime' | 'recipients' | 'ends' | 'review';
export type Step = {
  id: StepId;
  /** The question, in the words the screen asks it. */
  question: string;
  /** One line that says what the answer does. */
  hint: string;
  /** A step that may be left as it is. */
  optional?: true;
};

const STEPS: Record<StepId, Step> = {
  who: { id: 'who', question: 'Who is this rule for?', hint: 'A staff member or an approver with a passkey on Splash. Each person has one rule.' },
  per_payment: { id: 'per_payment', question: 'What is the most one payment may be?', hint: 'A bigger payment goes to the owners to pay. It cannot be more than the business’s own limit.' },
  cap: { id: 'cap', question: 'How much can they pay in a day or a month?', hint: 'The cap renews on its own. It counts each payment plus the most its fee could be.' },
  lifetime: { id: 'lifetime', question: 'Do you want a total limit for the whole rule?', hint: 'Optional. When it is used up, the rule stops paying until you change it.', optional: true },
  recipients: { id: 'recipients', question: 'Which recipients can they pay alone?', hint: 'Staff pay only recipients you have verified for the business. You can verify more now.', optional: true },
  ends: { id: 'ends', question: 'When does the rule end?', hint: 'The rule stops at the end of that day (UTC), within a year from today.' },
  review: { id: 'review', question: 'Check the rule', hint: 'Then ask the owners to sign. Nothing changes until they do.' },
};

/** A new rule asks who it is for and which recipients; a change is for one person already, and recipients belong to the business. */
export function ruleSteps(changing: boolean): Step[] {
  const ids: StepId[] = changing ? ['per_payment', 'cap', 'lifetime', 'ends', 'review'] : ['who', 'per_payment', 'cap', 'lifetime', 'recipients', 'ends', 'review'];
  return ids.map((id) => STEPS[id]);
}

const FIELDS: Record<StepId, Array<keyof RuleForm>> = {
  who: ['staffUserId'],
  per_payment: ['perPayment'],
  cap: ['cap'],
  lifetime: ['lifetimeCap'],
  recipients: [],
  ends: ['expires'],
  review: ['staffUserId', 'perPayment', 'cap', 'expires', 'lifetimeCap'],
};

/** What is wrong in this step's own fields, by field. Empty means the step may be left. */
export function validateStep(step: StepId, form: RuleForm, ctx: { now: Date; policyMaxMinor: bigint | null }): Partial<Record<keyof RuleForm, string>> {
  const made = ruleRequest(form, ctx);
  if (made.ok) return {};
  const out: Partial<Record<keyof RuleForm, string>> = {};
  for (const field of FIELDS[step]) if (made.errors[field]) out[field] = made.errors[field];
  return out;
}

export type RecipientPick = { address: string; tag: string };

/**
 * The recipients an owner chose to verify with a new rule, added to its body:
 * only a wallet or an exchange account, each address once. None, no key. The
 * route and the chain check the proof behind each one again.
 */
export function withRecipients(body: RuleBody, picks: RecipientPick[]): RuleBody & { recipients?: { add: Array<{ address: string; tag: 'wallet' | 'exchange' }> } } {
  const seen = new Set<string>();
  const add: Array<{ address: string; tag: 'wallet' | 'exchange' }> = [];
  for (const p of picks) {
    const address = p.address.trim();
    if (!address || (p.tag !== 'wallet' && p.tag !== 'exchange') || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    add.push({ address, tag: p.tag });
  }
  return add.length > 0 ? { ...body, recipients: { add } } : body;
}
