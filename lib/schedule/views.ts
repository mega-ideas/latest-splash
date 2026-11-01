/**
 * What the Scheduled tab, History and the routes' answers carry for scheduled
 * batches (v2 Phase 3): plain data, no server code, so a page can import the
 * types. The server builds them (lib/server/scheduled-payments.ts).
 */
import type { Cadence, RunGroup, RunStatus, RunTone, ScheduleMode, ScheduleStatus } from './rules.ts';
import type { ALLOWANCE_DEFAULTS } from './rules.ts';

export type ItemView = { position: number; payeeKind: 'splash_business' | 'recipient'; payeeId: string; name: string; masked: string; country: string | null; amountMinor: string; reference: string; feeMinor: string; /** Has nothing ever been paid to this address from this business? A first payment is never automatic. */ firstPayment: boolean };

export type RunView = {
  id: string;
  scheduleId: string;
  scheduleName: string;
  dueDate: string;
  dueAt: string;
  mode: ScheduleMode;
  ranAs: ScheduleMode | null;
  status: RunStatus;
  label: string;
  tone: RunTone;
  group: RunGroup;
  /** Plain words: what happened and why. */
  reason: string | null;
  reasonCode: string | null;
  /** An automatic run that was handed back to "ask me first". */
  fallback: boolean;
  itemCount: number;
  totalMinor: string;
  feeMinor: string;
  batchId: string | null;
  /** Skip is offered while nothing has been paid. */
  canSkip: boolean;
  /** When this run's first automatic payment may go out, once its window has been announced; null when it has none. Skip or Stop work until then. */
  startsAt: string | null;
  /** Is the warning window open, by the SERVER's clock? A device whose clock runs fast must not hide Skip or Stop. */
  windowOpen: boolean;
  /** The server's time when this was built: the page reads the window by it, not by the device clock alone. */
  serverNowMs: number;
  /** Where the receipt is, once it was paid. */
  receiptPath: string | null;
  payments: Array<{ position: number; payeeName: string; masked: string; amountMinor: string; feeMinor: string; status: string; digest: string | null; error: string | null }> | null;
  createdAt: string;
};

export type ScheduleView = {
  id: string;
  name: string;
  mode: ScheduleMode;
  cadence: Cadence;
  cadenceText: string;
  firstDueAt: string;
  nextDueAt: string | null;
  status: ScheduleStatus;
  createdBy: string;
  createdAs: 'owner' | 'finance_lead';
  itemCount: number;
  totalMinor: string;
  feeMinor: string;
  items: ItemView[];
  version: number;
  /** What the person asking may do with it. */
  can: { edit: boolean; skip: boolean; stop: boolean; delete: boolean };
  runs: RunView[];
};



export type AutomaticStatus = {
  /** Can the scheduled payer sign here at all? */
  payer: { ready: boolean; kind: 'kms' | 'sandbox' | null; reason: string | null; address: string | null };
  paused: boolean;
  /** The warning window, in minutes, before the first automatic payment of a run: 0 to 60, 10 unless an owner set it. */
  graceMinutes: number;
  pausedBy: string | null;
  pausedAt: string | null;
  dailyCapMinor: string;
  /** A daily limit the owners have been asked to sign; it applies once they have. */
  pendingDailyCapMinor: string | null;
  dailyUsedMinor: string;
  /** The owners' allowance to the scheduled payer, as the network has it now. Null when it could not be read. */
  allowance:
    | { state: 'none' }
    | { state: 'unreadable' }
    | {
        state: 'active' | 'expired' | 'not_started' | 'revoked';
        perPaymentMaxMinor: string;
        spendableNowMinor: string;
        startsAtMs: string | null;
        expiresAtMs: string | null;
        renewsAtMs: string | null;
      };
  defaults: typeof ALLOWANCE_DEFAULTS;
  /** The business's own limits now (Settings, Limits): the most an allowance may ask for. Amounts in USDC minor units, the length in days. */
  limits: { perPaymentMinor: string; dailyMinor: string; monthlyMinor: string; days: number };
};

