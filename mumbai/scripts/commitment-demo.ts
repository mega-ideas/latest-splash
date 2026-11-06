/**
 * Produce the demo payment's travel-rule commitment, and prove the scheme is
 * deterministic and salt-bound.
 *
 *   npm run commitment            # Payment A
 *   npm run commitment -- B       # Payment B (the one that expires)
 *
 * Writes the record, salt and commitment to demo/payment-<id>.json. The
 * beneficiary service reads that file, recomputes the commitment, and
 * acknowledges it. Only the commitment ever goes onchain.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { travelRuleCommitment, commitPayment, newSalt, fromHex, DOMAIN_TAG, type TravelRuleRecord } from '../lib/travel-rule-commitment.ts';

const which = (process.argv[2] ?? 'A').toUpperCase();

/**
 * A demo record. Simulated, and the README says so: a real one comes from
 * Splash's `travelRuleSnapshot()` over a KYB-verified business.
 */
const RECORDS: Record<string, TravelRuleRecord> = {
  A: {
    paymentRef: 'SPL-MUM-A-0001',
    originatorName: 'Acme Manufacturing Sdn Bhd',
    originatorIdentifier: 'SSM-202401234567',
    originatorAccount: '0xbf0e26d068caf355e9fb0767e33d33920b2e525b3b9351b24d30a2811dc3f872',
    originatorCountry: 'MY',
    beneficiaryName: 'Demo Supplier Pte Ltd',
    beneficiaryIdentifier: 'UEN-202412345A',
    beneficiaryAccount: '0x66c57041720e9b87be1304475b53db303b84d01b68b08d4fc83b69f5e4bfb26a',
    beneficiaryAgent: 'DEMOSGSGXXX',
    beneficiaryCountry: 'SG',
    purposeCode: 'GDDS',
    amount: 10_000_000n, // 10.000000 USDC — fits one 20 USDC faucet request with gas to spare
    currency: 'USDC',
    corridor: 'MY-SG',
  },
  B: {
    paymentRef: 'SPL-MUM-B-0002',
    originatorName: 'Acme Manufacturing Sdn Bhd',
    originatorIdentifier: 'SSM-202401234567',
    originatorAccount: '0xbf0e26d068caf355e9fb0767e33d33920b2e525b3b9351b24d30a2811dc3f872',
    originatorCountry: 'MY',
    beneficiaryName: 'Unresponsive Counterparty Ltd',
    beneficiaryIdentifier: 'UEN-209987654B',
    beneficiaryAccount: '0x9a3f1c57a2b4d6e8f0123456789abcdef0123456789abcdef0123456789abcde',
    beneficiaryAgent: 'DEMOSGSGXXX',
    beneficiaryCountry: 'SG',
    purposeCode: 'GDDS',
    amount: 2_000_000n, // 2.000000 USDC — the payment that is left to expire
    currency: 'USDC',
    corridor: 'MY-SG',
  },
};

const record = RECORDS[which];
if (!record) { console.error(`no demo record "${which}" (A or B)`); process.exit(1); }

const salt = newSalt();
const out = commitPayment(record, salt);

console.log(`domain tag  ${DOMAIN_TAG}`);
console.log(`payment ref ${record.paymentRef}`);
console.log(`amount      ${(Number(record.amount) / 1e6).toFixed(6)} ${record.currency}`);
console.log(`corridor    ${record.corridor}`);
console.log(`salt        ${out.salt}`);
console.log(`commitment  ${out.commitment}`);

// Determinism: the same record and salt always give the same value.
const again = travelRuleCommitment(record, salt);
const sameValue = out.commitment === `0x${Buffer.from(again).toString('hex')}`;

// Salt-binding: a different salt gives a different value, so the commitment
// reveals nothing about the record to anyone who does not hold the salt.
const other = travelRuleCommitment(record, newSalt());
const differs = out.commitment !== `0x${Buffer.from(other).toString('hex')}`;

// Field-binding: one changed field changes the commitment.
const tampered = travelRuleCommitment({ ...record, amount: BigInt(record.amount) + 1n }, salt);
const bound = out.commitment !== `0x${Buffer.from(tampered).toString('hex')}`;

console.log(`\ndeterministic  ${sameValue ? 'yes' : 'NO'}`);
console.log(`salt-bound     ${differs ? 'yes' : 'NO'}`);
console.log(`field-bound    ${bound ? 'yes' : 'NO'}`);
if (!sameValue || !differs || !bound) process.exit(1);

mkdirSync(new URL('../demo', import.meta.url).pathname, { recursive: true });
const path = new URL(`../demo/payment-${which}.json`, import.meta.url).pathname;
writeFileSync(path, JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(`\nwritten  ${path}`);
