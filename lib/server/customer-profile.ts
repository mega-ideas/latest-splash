import fs from 'node:fs';
import path from 'node:path';

/**
 * Customer profile + maker-checker change requests.
 *
 * The customer can view their profile freely, but every edit is captured as a
 * PENDING change request that a staff admin must approve before it becomes the
 * profile of record (tier moves included, e.g. TIER_3 → TIER_1). The applied
 * profile is only ever mutated by an admin decision — never directly by the
 * customer — and every transition appends to an immutable audit trail.
 */

export type AccountTier = 'TIER_1' | 'TIER_2' | 'TIER_3';

export type CustomerProfile = {
  /** Identity key — comes from the session, never editable. */
  email: string;
  displayName: string;
  organization: string;
  phone: string;
  country: string;
  timezone: string;
  tier: AccountTier;
  updatedAt: string;
  /** The change request that produced the current values, if any. */
  appliedRequestId: string | null;
};

export type ProfileChangeFields = Partial<
  Pick<CustomerProfile, 'displayName' | 'organization' | 'phone' | 'country' | 'timezone' | 'tier'>
>;

export type ProfileRequestState = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export type ProfileAuditEvent = {
  actor: string;
  action: string;
  note: string | null;
  at: string;
};

export type ProfileChangeRequest = {
  id: string;
  email: string;
  state: ProfileRequestState;
  /** Requested field values (only the fields being changed). */
  changes: ProfileChangeFields;
  /** Snapshot of the profile at submission time, for the admin diff view. */
  before: ProfileChangeFields;
  note: string | null;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  auditTrail: ProfileAuditEvent[];
};

export const TIER_LABELS: Record<AccountTier, string> = {
  TIER_1: 'Tier 1 · Prime',
  TIER_2: 'Tier 2 · Growth',
  TIER_3: 'Tier 3 · Starter',
};

const ACCOUNT_TIERS: AccountTier[] = ['TIER_1', 'TIER_2', 'TIER_3'];

const DATA_DIR = process.env.SPLASH_DATA_DIR ?? path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'customer-profiles.json');

type ProfileStore = {
  profiles: Record<string, CustomerProfile>;
  requests: ProfileChangeRequest[];
};

function readStore(): ProfileStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Partial<ProfileStore>;
    return {
      profiles: parsed.profiles ?? {},
      requests: Array.isArray(parsed.requests) ? parsed.requests : [],
    };
  } catch {
    return { profiles: {}, requests: [] };
  }
}

function writeStore(store: ProfileStore) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${STORE_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, STORE_PATH);
}

function requestId() {
  return `pcr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function auditEvent(actor: string, action: string, note?: string | null): ProfileAuditEvent {
  return { actor, action, note: note ?? null, at: new Date().toISOString() };
}

function normalizeKey(email: string) {
  return email.trim().toLowerCase();
}

const text = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

function sanitizeChanges(input: Record<string, unknown>): ProfileChangeFields {
  const changes: ProfileChangeFields = {};
  if (input.displayName !== undefined) changes.displayName = text(input.displayName, 80);
  if (input.organization !== undefined) changes.organization = text(input.organization, 120);
  if (input.phone !== undefined) changes.phone = text(input.phone, 32);
  if (input.country !== undefined) changes.country = text(input.country, 2).toUpperCase();
  if (input.timezone !== undefined) changes.timezone = text(input.timezone, 64);
  if (input.tier !== undefined) {
    const tier = String(input.tier).toUpperCase() as AccountTier;
    if (!ACCOUNT_TIERS.includes(tier)) throw new Error('Unknown account tier requested.');
    changes.tier = tier;
  }
  return changes;
}

/** Read (and lazily seed) the profile of record for a customer. */
export function getCustomerProfile(identity: {
  email: string;
  name?: string;
  organization?: string;
}): CustomerProfile {
  const key = normalizeKey(identity.email);
  const store = readStore();
  const existing = store.profiles[key];
  if (existing) return existing;

  // First sight of this customer: seed from the session identity.
  return {
    email: key,
    displayName: identity.name?.trim() || key.split('@')[0] || 'Operator',
    organization: identity.organization?.trim() || 'Unnamed business',
    phone: '',
    country: 'MY',
    timezone: 'Asia/Kuala_Lumpur',
    tier: 'TIER_3',
    updatedAt: new Date(0).toISOString(),
    appliedRequestId: null,
  };
}

export function getPendingRequest(email: string): ProfileChangeRequest | null {
  const key = normalizeKey(email);
  return readStore().requests.find((r) => r.email === key && r.state === 'PENDING') ?? null;
}

export function listRequestsForCustomer(email: string): ProfileChangeRequest[] {
  const key = normalizeKey(email);
  return readStore()
    .requests.filter((r) => r.email === key)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

/** Customer submits an edit — stored as a pending request, nothing applies yet. */
export function submitProfileChangeRequest(
  identity: { email: string; name?: string; organization?: string },
  input: Record<string, unknown>,
): ProfileChangeRequest {
  const key = normalizeKey(identity.email);
  const store = readStore();

  if (store.requests.some((r) => r.email === key && r.state === 'PENDING')) {
    throw new Error('A change request is already pending review. Cancel it before submitting another.');
  }

  const profile = store.profiles[key] ?? getCustomerProfile(identity);
  const changes = sanitizeChanges(input);

  // Drop no-op fields so the admin diff shows only real changes.
  const before: ProfileChangeFields = {};
  for (const field of Object.keys(changes) as Array<keyof ProfileChangeFields>) {
    if (changes[field] === profile[field]) {
      delete changes[field];
    } else {
      (before as Record<string, unknown>)[field] = profile[field];
    }
  }
  if (Object.keys(changes).length === 0) {
    throw new Error('Nothing changed — the request matches the current profile.');
  }
  if (changes.displayName !== undefined && changes.displayName.length < 2) {
    throw new Error('Display name must be at least 2 characters.');
  }
  if (changes.organization !== undefined && changes.organization.length < 2) {
    throw new Error('Organization must be at least 2 characters.');
  }

  const request: ProfileChangeRequest = {
    id: requestId(),
    email: key,
    state: 'PENDING',
    changes,
    before,
    note: text(input.note, 500) || null,
    submittedAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    auditTrail: [auditEvent(key, 'SUBMITTED', text(input.note, 500) || null)],
  };

  // Persist the seeded profile alongside so the admin diff has a stable base.
  store.profiles[key] = profile;
  store.requests.push(request);
  writeStore(store);
  return request;
}

/** Customer withdraws their own pending request. */
export function cancelPendingRequest(email: string): ProfileChangeRequest {
  const key = normalizeKey(email);
  const store = readStore();
  const request = store.requests.find((r) => r.email === key && r.state === 'PENDING');
  if (!request) throw new Error('No pending change request to cancel.');

  request.state = 'CANCELLED';
  request.decidedAt = new Date().toISOString();
  request.decidedBy = key;
  request.auditTrail.push(auditEvent(key, 'CANCELLED'));
  writeStore(store);
  return request;
}

// ─── Admin (checker) side ─────────────────────────────────────────────────────

export function listProfileRequestsForStaff(): Array<ProfileChangeRequest & { currentProfile: CustomerProfile }> {
  const store = readStore();
  return store.requests
    .slice()
    .sort((a, b) => {
      // Pending first, then newest.
      if ((a.state === 'PENDING') !== (b.state === 'PENDING')) return a.state === 'PENDING' ? -1 : 1;
      return b.submittedAt.localeCompare(a.submittedAt);
    })
    .map((request) => ({
      ...request,
      currentProfile: store.profiles[request.email] ?? getCustomerProfile({ email: request.email }),
    }));
}

export function decideProfileRequestForStaff(
  id: string,
  decision: { action: 'approve' | 'reject'; actor: string; reason?: string },
): ProfileChangeRequest {
  const store = readStore();
  const request = store.requests.find((r) => r.id === id);
  if (!request) throw new Error('Change request not found.');
  if (request.state !== 'PENDING') throw new Error(`Change request is already ${request.state.toLowerCase()}.`);

  const now = new Date().toISOString();
  const reason = decision.reason?.trim() || null;

  if (decision.action === 'approve') {
    const profile = store.profiles[request.email] ?? getCustomerProfile({ email: request.email });
    store.profiles[request.email] = {
      ...profile,
      ...request.changes,
      email: request.email, // identity never changes
      updatedAt: now,
      appliedRequestId: request.id,
    };
    request.state = 'APPROVED';
    request.auditTrail.push(auditEvent(decision.actor, 'APPROVED', reason));
  } else {
    request.state = 'REJECTED';
    request.auditTrail.push(auditEvent(decision.actor, 'REJECTED', reason));
  }

  request.decidedAt = now;
  request.decidedBy = decision.actor;
  request.decisionReason = reason;
  writeStore(store);
  return request;
}
