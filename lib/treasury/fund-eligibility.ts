/**
 * Whether a business may be referred to the fund manager (v2 D9, brief 5.7):
 * the eligibility questions, and what the answers mean.
 *
 * The fund is offered only to sophisticated investors as the Securities
 * Commission Malaysia defines them (the categories it publishes for the
 * Capital Markets and Services Act 2007, Schedules 6 and 7). A business
 * qualifies through one of the categories a CORPORATE investor can meet:
 *
 *   regulated_institution  a bank, insurer, capital markets intermediary, or
 *                          another institution the Securities Commission
 *                          lists as an accredited investor;
 *   net_assets             total net assets above RM10 million, or the
 *                          equivalent in foreign currency, on its latest
 *                          financial statements;
 *   wholly_owned           every shareholder is itself an accredited
 *                          investor, a high-net-worth entity or a
 *                          high-net-worth individual.
 *
 * A high-net-worth individual, for the third: net personal assets above RM3
 * million; or gross annual income above RM300,000 (RM400,000 jointly with a
 * spouse) in the preceding 12 months; or a net personal investment portfolio
 * above RM1 million.
 *
 * The questions are answered by an owner for the business, with a
 * declaration that the answers are true. Splash records the answers and the
 * outcome; it checks no financial statement, and the fund manager makes its
 * own assessment before accepting anyone. A "not eligible" result is final
 * for these answers: nothing is shown that would let a business that does
 * not qualify reach the referral.
 *
 * The wording here is the part that needs legal sign-off before mainnet
 * (docs/MAINNET-CHECKLIST.md), which is why the whole section is behind
 * FEATURE_FUND_REFERRAL, off.
 *
 * Pure and import-free: the page renders the questions from this file, and
 * the server evaluates the answers with the same function.
 */

export const FUND_QUESTION_IDS = ['malaysia', 'regulated_institution', 'net_assets', 'wholly_owned', 'declaration'] as const;
export type FundQuestionId = (typeof FUND_QUESTION_IDS)[number];

export type FundAnswers = Record<FundQuestionId, boolean>;

export type FundCategory = 'regulated_institution' | 'net_assets' | 'wholly_owned';

export const FUND_QUESTIONS: ReadonlyArray<{ id: FundQuestionId; question: string; help?: string }> = [
  {
    id: 'malaysia',
    question: 'Is the business incorporated in Malaysia?',
    help: 'These questions follow the Securities Commission Malaysia’s definitions of a sophisticated investor.',
  },
  {
    id: 'regulated_institution',
    question: 'Is the business a bank, an insurer, a capital markets intermediary, or another institution the Securities Commission Malaysia lists as an accredited investor?',
  },
  {
    id: 'net_assets',
    question: 'Are the business’s total net assets above RM10 million (or the equivalent in another currency) on its latest financial statements?',
  },
  {
    id: 'wholly_owned',
    question: 'Is every shareholder an accredited investor, a high-net-worth entity or a high-net-worth individual?',
    help: 'A high-net-worth individual has net personal assets above RM3 million, gross annual income above RM300,000 (RM400,000 jointly with a spouse) in the last 12 months, or a net personal investment portfolio above RM1 million.',
  },
  {
    id: 'declaration',
    question: 'I answer for the business, and these answers are true.',
  },
];

export const FUND_CATEGORY_LABEL: Record<FundCategory, string> = {
  regulated_institution: 'Accredited investor (a regulated institution)',
  net_assets: 'High-net-worth entity (net assets above RM10 million)',
  wholly_owned: 'Wholly owned by sophisticated investors',
};

export type FundEligibility =
  | { outcome: 'eligible'; category: FundCategory; reason: string }
  | { outcome: 'not_eligible'; category: null; reason: string };

/**
 * Read the answers from a request body. Every question must be answered with
 * a boolean: a missing or non-boolean answer is not a "no", it is an
 * incomplete form, and the caller is told which.
 */
export function parseFundAnswers(raw: unknown): { ok: true; answers: FundAnswers } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Answer every question.' };
  const source = raw as Record<string, unknown>;
  const extra = Object.keys(source).filter((k) => !(FUND_QUESTION_IDS as readonly string[]).includes(k));
  if (extra.length > 0) return { ok: false, error: `Unknown questions: ${extra.join(', ')}.` };
  const missing = FUND_QUESTION_IDS.filter((id) => typeof source[id] !== 'boolean');
  if (missing.length > 0) return { ok: false, error: `Answer every question (missing: ${missing.join(', ')}).` };
  return { ok: true, answers: Object.fromEntries(FUND_QUESTION_IDS.map((id) => [id, source[id] === true])) as FundAnswers };
}

/** What the answers mean. The first category that applies is recorded. */
export function evaluateFundEligibility(answers: FundAnswers): FundEligibility {
  if (!answers.declaration) {
    return { outcome: 'not_eligible', category: null, reason: 'The answers were not declared true, so they cannot be relied on.' };
  }
  if (!answers.malaysia) {
    return {
      outcome: 'not_eligible',
      category: null,
      reason: 'The fund is offered under Malaysian rules, and this business is not incorporated in Malaysia.',
    };
  }
  const category: FundCategory | null = answers.regulated_institution
    ? 'regulated_institution'
    : answers.net_assets
      ? 'net_assets'
      : answers.wholly_owned
        ? 'wholly_owned'
        : null;
  if (!category) {
    return {
      outcome: 'not_eligible',
      category: null,
      reason: 'The business does not meet a sophisticated-investor category, so it cannot be referred to the fund.',
    };
  }
  return { outcome: 'eligible', category, reason: `${FUND_CATEGORY_LABEL[category]}.` };
}
