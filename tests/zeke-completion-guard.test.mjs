/**
 * v2 Phase 3, Zeke text: Zeke never says money moved.
 *
 * The model writes some of what Zeke says, and a model can say "Paid!" about a
 * payment that is only a draft (a prompt-injected invoice asks it to, or it
 * simply rounds up). Zeke cannot send, approve or sign anything, so a sentence
 * that says money has been or is being sent, paid or done is false whatever
 * the model meant.
 *
 * lib/agent/oxwal.ts therefore guards the reply in code, not in the prompt: on
 * a turn that proposes, prepares or discusses a money movement, a sentence that
 * claims completion does not reach the person. It is dropped and the reply
 * carries a fixed, truthful line instead.
 *
 *   - hostile phrasing: look-alike letters, hidden characters, spaced and
 *     dotted letters, digits for letters, small caps, accents, stretched words,
 *     markdown, and a claim tucked into a reassuring sentence;
 *   - other languages: the same claims in the languages of the corridors and
 *     the common ones a customer writes in;
 *   - truthful sentences stay: negations, "will be sent once approved", the
 *     limitation statement, the proposal's own words;
 *   - turns that are not about money are never touched.
 *
 * The opening message and the Zeke page header (the fixed limit sentence) are
 * not touched by this: Sky decided to keep them as they are.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as oxwal from '../lib/agent/oxwal.ts';
import { resetZekeSessionNoticesForTesting } from '../lib/server/zeke-session-notices.ts';

const {
  OXWAL_SYSTEM_PROMPT,
  ZEKE_FIRST_RECIPIENT_NUDGE,
  ZEKE_LIMITATION_TEXT,
  resetOxwalFixtures,
  resetOxwalProposalStore,
  runOxwalAgent,
  setOxwalModelClientForTesting,
} = oxwal;

const PREPARED_LINE = 'Nothing has been sent. It is waiting for approval.';
const PLAIN_LINE = "I haven't sent anything. I can't approve or send payments, so a person on your team does that.";

function guard(text, { level = 'strict', prepared = true } = {}) {
  assert.equal(typeof oxwal.guardCompletionClaims, 'function', 'guardCompletionClaims is exported');
  return oxwal.guardCompletionClaims(text, { level, prepared });
}

function level(message, history) {
  assert.equal(typeof oxwal.moneyTurnLevel, 'function', 'moneyTurnLevel is exported');
  return oxwal.moneyTurnLevel(message, history);
}

async function turn(request) {
  const events = [];
  for await (const event of runOxwalAgent({ forceLocal: true, ...request })) events.push(event);
  return events;
}

const textOf = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const count = (text, part) => text.split(part).length - 1;

function toolUse(id, name, input) {
  return { type: 'tool_use', id, name, input };
}

/** A scripted stand-in for the Anthropic client. `reply` may be a list or a function of the request. */
function fakeModel(reply) {
  let index = 0;
  return {
    messages: {
      async create(params) {
        if (typeof reply === 'function') return reply(params);
        const response = reply[index] ?? { content: [{ type: 'text', text: '' }] };
        index += 1;
        return response;
      },
    },
  };
}

const MONEY_HISTORY = [
  { role: 'user', content: 'Pay Acme 600 USD' },
  { role: 'assistant', content: `${ZEKE_LIMITATION_TEXT.PAYMENT}\n\nI prepared a payment of 600 USD to Acme Manufacturing PH.` },
];

test.beforeEach(() => {
  resetOxwalFixtures();
  resetOxwalProposalStore();
  resetZekeSessionNoticesForTesting();
  setOxwalModelClientForTesting(null);
});

// ── The pure guard ─────────────────────────────────────────────────────────

const CLAIMS = [
  'Paid!',
  'Sent.',
  'Done!',
  'Done, I have queued it.',
  'All done.',
  'Done I transferred it',
  'I sent 500 USDC to Manila Parts.',
  "I've paid Acme.",
  'I transferred the funds.',
  'We have wired the money.',
  'Zeke has released the funds.',
  'Payment sent.',
  'Your payment has been sent.',
  'The transfer is complete.',
  'It has been paid.',
  'It was settled a moment ago.',
  'The payout has been executed.',
  'It has been successfully transferred to Acme.',
  'The money is on its way.',
  'Funds are on their way to Acme.',
  'I am sending it now.',
  "I'm processing the payment now.",
  'Payment successful.',
  'Transaction completed successfully.',
  'The payment went through.',
  'Consider it done.',
  'I approved the payment.',
  'I signed it for you.',
  'Your invoice is now paid.',
  'Good news: it is sent.',
  'Sure, approving it now.',
  'Okay, sending now!',
  'Money moved.',
  'Acme has received the funds.',
  'The funds have arrived.',
  'It has gone out.',
  'Transaction hash: 0xabc123def456',
  'Releasing the funds now.',
  'Done - I have queued the payment to Acme for 1250.',
  // A claim wrapped in reassurance, or followed by a negation that is about something else.
  'Paid, and no further steps are needed.',
  'You can relax, I have sent it.',
  'There is no doubt about it, it is paid.',
];

test('a sentence that says money was or is being sent, paid or done is replaced by the fixed line', () => {
  for (const claim of CLAIMS) {
    const out = guard(claim);
    assert.equal(out.replaced, true, claim);
    assert.equal(out.text, PREPARED_LINE, claim);
  }
});

test('only the claiming sentence goes; the true ones around it stay, with the line last', () => {
  const out = guard('I prepared a payment of 500 USDC to Manila Parts Supply. Sent! Please open it in Wallet to review.');
  assert.equal(out.replaced, true);
  assert.equal(out.text, `I prepared a payment of 500 USDC to Manila Parts Supply. Please open it in Wallet to review.\n\n${PREPARED_LINE}`);
  const many = guard('Paid! Done. I transferred 500 USDC to Acme.\nIt is on its way!');
  assert.equal(many.text, PREPARED_LINE, 'every claiming sentence goes, and the line is said once');
});

test('with nothing prepared this turn the line does not promise an approval that does not exist', () => {
  const out = guard('Yes, it was sent a few minutes ago.', { prepared: false });
  assert.equal(out.replaced, true);
  assert.equal(out.text, PLAIN_LINE);
  assert.equal(out.text.includes('waiting for approval'), false);
});

const OBFUSCATED = [
  ['Cyrillic look-alike P', '\u0420aid!'],
  ['Cyrillic look-alike e', 'S\u0435nt!'],
  ['Cyrillic look-alike a in a sentence', 'I h\u0430ve sent it.'],
  ['Greek omicron', 'D\u03bfne!'],
  ['full-width letters', '\uff33\uff45\uff4e\uff54\uff01'],
  ['math bold letters', '\ud835\udc0f\ud835\udc1a\ud835\udc22\ud835\udc1d!'],
  ['circled letters', '\u24df\u24d0\u24d8\u24d3'],
  ['small caps', '\u1d18\u1d00\u026a\u1d05!'],
  ['zero-width space inside', 'Pa\u200bid!'],
  ['zero-width joiner and soft hyphen', 'I h\u200dave s\u00adent it.'],
  ['spaced letters', 'P a i d !'],
  ['dotted letters', 'S.e.n.t.'],
  ['hyphenated letters', 'P-a-i-d!'],
  ['digits for letters', 'S3nt!'],
  ['digit four for a', 'P4id!'],
  ['zero for o', 'd0ne!'],
  ['stretched word', 'Paaaaid!'],
  ['stretched done', 'Dooooone!'],
  ['accents', 'P\u00e0\u00efd!'],
  ['combining marks', 'Pa\u0301i\u0308d!'],
  ['markdown bold', '**Paid**'],
  ['markdown italics and backticks', '_Sent_ `it`'],
  ['shouting', 'SENT!!!'],
  ['mixed case', 'pAiD'],
  ['a claim after an abrupt full stop', 'OK.Paid!'],
];

test('look-alike letters, hidden characters and other disguises do not hide a completion claim', () => {
  for (const [label, text] of OBFUSCATED) {
    const out = guard(text);
    assert.equal(out.replaced, true, label);
    assert.ok(out.text.endsWith(PREPARED_LINE), label);
    // Whatever stays is not the claim: only the line, or the true words beside it ("OK.").
    assert.doesNotMatch(out.text.slice(0, -PREPARED_LINE.length), /paid|sent|done/i, label);
  }
});

const OTHER_LANGUAGES = [
  ['Indonesian', 'Pembayaran berhasil dikirim.'],
  ['Indonesian', 'Sudah saya kirim ke Acme.'],
  ['Indonesian', 'Sudah dibayar!'],
  ['Malay', 'Pembayaran telah dihantar.'],
  ['Tagalog', 'Naipadala na!'],
  ['Tagalog', 'Nabayaran na ang invoice.'],
  ['Vietnamese', '\u0110\u00e3 g\u1eedi ti\u1ec1n cho Acme.'],
  ['Vietnamese', '\u0110\u00e3 thanh to\u00e1n xong.'],
  ['Thai', '\u0e2a\u0e48\u0e07\u0e40\u0e07\u0e34\u0e19\u0e41\u0e25\u0e49\u0e27'],
  ['Thai', '\u0e42\u0e2d\u0e19\u0e40\u0e23\u0e35\u0e22\u0e1a\u0e23\u0e49\u0e2d\u0e22\u0e41\u0e25\u0e49\u0e27'],
  ['Chinese', '\u5df2\u8f6c\u8d26\u7ed9Acme\u3002'],
  ['Chinese', '\u4ed8\u6b3e\u6210\u529f\uff01'],
  ['Chinese', '\u5df2\u7ecf\u53d1\u9001\u4e86\u3002'],
  ['Chinese', '\u641e\u5b9a\uff01'],
  ['Japanese', '\u9001\u91d1\u3057\u307e\u3057\u305f\u3002'],
  ['Japanese', '\u652f\u6255\u3044\u6e08\u307f\u3067\u3059\u3002'],
  ['Korean', '\uc1a1\uae08\ud588\uc2b5\ub2c8\ub2e4.'],
  ['Korean', '\uacb0\uc81c\uac00 \uc644\ub8cc\ub418\uc5c8\uc2b5\ub2c8\ub2e4.'],
  ['Spanish', 'Pago enviado.'],
  ['Spanish', 'Ya lo he enviado.'],
  ['Spanish', '\u00a1Listo, he pagado a Acme!'],
  ['Spanish', 'La transferencia ha sido completada.'],
  ['French', "J'ai envoy\u00e9 le paiement."],
  ['French', 'Paiement effectu\u00e9.'],
  ['French', "C'est fait !"],
  ['Portuguese', 'Pagamento enviado.'],
  ['Portuguese', 'J\u00e1 paguei o fornecedor.'],
  ['Portuguese', 'Transfer\u00eancia conclu\u00edda.'],
  ['German', 'Ich habe das Geld \u00fcberwiesen.'],
  ['German', 'Zahlung erfolgreich.'],
  ['German', 'Erledigt!'],
  ['Italian', 'Ho inviato il pagamento.'],
  ['Italian', 'Pagamento effettuato.'],
  ['Russian', '\u041f\u043b\u0430\u0442\u0451\u0436 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d.'],
  ['Russian', '\u042f \u043f\u0435\u0440\u0435\u0432\u0451\u043b \u0434\u0435\u043d\u044c\u0433\u0438.'],
  ['Russian', '\u0413\u043e\u0442\u043e\u0432\u043e!'],
  ['Arabic', '\u062a\u0645 \u0627\u0644\u0625\u0631\u0633\u0627\u0644.'],
  ['Arabic', '\u062a\u0645 \u0627\u0644\u062f\u0641\u0639 \u0628\u0646\u062c\u0627\u062d.'],
  ['Hindi', '\u092d\u0947\u091c \u0926\u093f\u092f\u093e \u0917\u092f\u093e \u0939\u0948\u0964'],
  ['Hindi', '\u092d\u0941\u0917\u0924\u093e\u0928 \u0939\u094b \u0917\u092f\u093e\u0964'],
  ['Turkish', '\u00d6deme g\u00f6nderildi.'],
  ['Turkish', 'Tamamland\u0131.'],
  ['Dutch', 'De betaling is voltooid.'],
  ['Dutch', 'Ik heb het geld overgemaakt.'],
];

test('the same claims in the other languages Zeke is written to are replaced too', () => {
  for (const [language, text] of OTHER_LANGUAGES) {
    const out = guard(text);
    assert.equal(out.replaced, true, `${language}: ${text}`);
    assert.equal(out.text, PREPARED_LINE, `${language}: ${text}`);
  }
});

const TRUTHFUL = [
  'Nothing has been sent. It is waiting for approval.',
  "I haven't sent anything.",
  "I can prepare this payment, but I can't approve or send it.",
  'It will be sent once a person on your team approves it.',
  'Once approved, it will be sent from your Splash Wallet.',
  'The payment has not been sent yet.',
  'No payment has been made.',
  'This payment cannot be sent until the recipient is verified.',
  'I prepared a payment of 500 USDC to Manila Parts Supply.',
  'I have queued it for approval.',
  'It is waiting for approval from a teammate.',
  'Do you want me to send it?',
  'Please review and approve it in Wallet.',
  'Nothing leaves your wallet until someone approves it.',
  "I can't send money.",
  'I drafted an unsigned payment proposal. It is not executable until policy evaluation passes and a human signs the transaction bytes.',
  'Your balance is 4,200 USDC.',
  'Paid invoices are listed under Receipts.',
  'Sent items appear in your history.',
  'Hello, how can I help?',
  'Acme Manufacturing PH is verified. Want me to draft 600 USD?',
  'Your fee is 0.5% of the amount, shown before you approve.',
  'Once you approve it in Wallet, the transfer is sent from your Splash Wallet.',
  'I will prepare the payment and a teammate will approve it.',
  'The transfer is waiting for a second approver.',
  'The payment is not complete until both approvers sign.',
  'Nothing was paid.',
  'I cannot confirm whether it was sent.',
  'This would have been paid on 3 October.',
  'If it had been sent, you would see a receipt.',
  'Done with the review of the invoice.',
  'Sent and received items are under History.',
  'Approved payments appear in the queue.',
  'Completed batches are listed on the Batches page.',
  'Your account is signed in as Dana.',
  'Here is last month: you paid Acme 500 USDC on 3 October.',
  'The fee on 500.50 USDC is 0.50 USDC.',
  ZEKE_LIMITATION_TEXT.PAYMENT,
  ZEKE_LIMITATION_TEXT.BATCH,
  ZEKE_LIMITATION_TEXT.TREASURY,
  ZEKE_LIMITATION_TEXT.READ,
  ZEKE_FIRST_RECIPIENT_NUDGE,
  PREPARED_LINE,
  PLAIN_LINE,
  // Other languages, said truthfully.
  'A\u00fan no se ha enviado nada.',
  "Rien n'a \u00e9t\u00e9 envoy\u00e9.",
  'Belum dikirim, menunggu persetujuan.',
  '\u5c1a\u672a\u53d1\u9001\uff0c\u7b49\u5f85\u6279\u51c6\u3002',
  '\u627f\u8a8d\u3055\u308c\u308b\u307e\u3067\u9001\u91d1\u3055\u308c\u307e\u305b\u3093\u3002',
  'Nichts wurde gesendet.',
  'Nog niets is verzonden.',
  'Nada foi enviado ainda.',
  'Ancora nulla \u00e8 stato inviato.',
  '\u041f\u043e\u043a\u0430 \u043d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e.',
  '\u0644\u0645 \u064a\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u0623\u064a \u0634\u064a\u0621.',
];

test('true sentences are left exactly as written: negations, conditions, the limit statement, the proposal\'s own words', () => {
  for (const text of TRUTHFUL) {
    const out = guard(text);
    assert.equal(out.replaced, false, text);
    assert.equal(out.text, text, text);
  }
});

test('the guard is a fixed point: running it on its own output changes nothing', () => {
  for (const claim of [...CLAIMS, ...OBFUSCATED.map(([, text]) => text), ...OTHER_LANGUAGES.map(([, text]) => text)]) {
    const once = guard(`Ok. ${claim} Thanks.`);
    const twice = guard(once.text);
    assert.equal(twice.replaced, false, claim);
    assert.equal(twice.text, once.text, claim);
    // And the same input gives the same output every time.
    assert.deepEqual(guard(`Ok. ${claim} Thanks.`), once);
  }
});

test('a long or adversarial reply is guarded in reasonable time', () => {
  const started = Date.now();
  const spaced = `${'a b c d e f g h '.repeat(2000)}Paid!`;
  const dotted = `${'x.'.repeat(5000)} Sent.`;
  const stretched = `${'p'.repeat(20000)}aid!`;
  const long = `${'I prepared the payment for review. '.repeat(1500)}Done!`;
  for (const text of [dotted, stretched, long]) {
    const out = guard(text);
    assert.equal(out.replaced, true);
    assert.ok(out.text.endsWith(PREPARED_LINE));
  }
  // A wall of single letters is read once, in time (it holds no claim to find).
  guard(spaced);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
});

test('a discussion turn keeps a dated statement of what already happened and drops an undated claim', () => {
  const dated = 'Acme was paid 500 USDC on 3 October (receipt R-1042).';
  assert.deepEqual(guard(dated, { level: 'topic' }), { text: dated, replaced: false });
  assert.deepEqual(guard('You paid Acme last week.', { level: 'topic' }), { text: 'You paid Acme last week.', replaced: false });
  assert.equal(guard('Acme was paid.', { level: 'topic' }).replaced, true);
  assert.equal(guard('I sent it.', { level: 'topic' }).replaced, true);
  // On a turn that prepares a payment, a date does not make "sent" true.
  assert.equal(guard('It was sent on 3 October.', { level: 'strict' }).replaced, true);
  // A bare "Done!" is a claim on a payment turn; on a discussion turn it is just a word.
  assert.equal(guard('Done! Here is your summary.', { level: 'topic' }).replaced, false);
  assert.equal(guard('Done! Here is your summary.', { level: 'strict' }).replaced, true);
});

// ── Which turns are money turns ────────────────────────────────────────────

test('the money turns are told from the others by the message and the thread', () => {
  const strict = ['Send 500 USDC to Manila Parts', 'Pay Acme', 'Prepare a batch for this month', 'Run payroll', 'Kirim 500 USDC ke Acme', 'Paga a Acme 500 USD', 'Envoie 500 USD a Acme'];
  for (const message of strict) assert.equal(level(message, []), 'strict', message);

  const topic = ['What did we pay last month?', 'Show me my receipts for payments', 'How do I pay a supplier in the Philippines?', 'Wie funktioniert die Zahlung?', '\u652f\u4ed8\u4e86\u591a\u5c11\uff1f'];
  for (const message of topic) assert.equal(level(message, []), 'topic', message);

  const none = ['How do fees work?', 'Hi Zeke', 'Call yourself Ada', 'Add Acme as a recipient', 'Thanks!', 'What can you do?'];
  for (const message of none) assert.equal(level(message, []), 'none', message);

  // A short reply is about money when the thread is.
  for (const message of ['yes, go ahead', 'ok', 'Did it go through?', 'Is it done?', 'status', 'confirm', 'Approve it']) {
    assert.equal(level(message, MONEY_HISTORY), 'strict', message);
    assert.equal(level(message, []), 'none', `${message} with no money in the thread`);
  }
  assert.equal(level('yes, go ahead', [{ role: 'assistant', content: 'Your name is now Ada.' }]), 'none');
});

// ── The stream ─────────────────────────────────────────────────────────────

test('a model that says "Paid!" about a draft never gets it to the person, and the limit is still said first', async () => {
  setOxwalModelClientForTesting(fakeModel([
    {
      content: [
        { type: 'text', text: 'Paid! Done. I transferred 500 USD to Acme.' },
        toolUse('t1', 'proposePayment', { orgId: 'demo-business', counterpartyId: 'cp_acme_ph', amountUsd: 600, currency: 'PHP' }),
      ],
    },
    { content: [{ type: 'text', text: 'Sent! Your money is on its way.' }] },
  ]));
  const events = await turn({ message: 'yes, go ahead', orgId: 'demo-business', sessionKey: 's-guard-1', history: MONEY_HISTORY, forceLocal: false });
  const text = textOf(events);
  assert.ok(events.some((e) => e.type === 'proposal'), 'the payment is prepared');
  for (const claim of ['Paid!', 'Done.', 'I transferred', 'Sent!', 'on its way']) {
    assert.equal(text.includes(claim), false, claim);
  }
  assert.equal(count(text, PREPARED_LINE), 1, 'the line is said once');
  assert.ok(text.startsWith(ZEKE_LIMITATION_TEXT.PAYMENT), 'the limit statement still opens the reply');
  assert.ok(text.indexOf(PREPARED_LINE) > text.indexOf(ZEKE_LIMITATION_TEXT.PAYMENT));
  const noticeAt = events.findIndex((e) => e.type === 'notice' && e.notice === 'MONEY_LIMIT');
  const toolAt = events.findIndex((e) => e.type === 'tool' && e.name === 'proposePayment');
  assert.ok(noticeAt >= 0 && noticeAt < toolAt);
});

test('the words that lead up to a proposal still come before its card, and the line is said once whichever side the claims are on', async () => {
  setOxwalModelClientForTesting(fakeModel([
    {
      content: [
        { type: 'text', text: 'I prepared the payment to Acme. Paid!' },
        toolUse('t1', 'proposePayment', { orgId: 'demo-business', counterpartyId: 'cp_acme_ph', amountUsd: 600, currency: 'PHP' }),
      ],
    },
    { content: [{ type: 'text', text: 'Sent! It is on its way.' }] },
  ]));
  const events = await turn({ message: 'yes, go ahead', orgId: 'demo-business', history: MONEY_HISTORY, forceLocal: false });
  const proposalAt = events.findIndex((e) => e.type === 'proposal');
  const wordsAt = events.findIndex((e) => e.type === 'delta' && e.text.includes('prepared'));
  const lineAt = events.findIndex((e) => e.type === 'delta' && e.text.includes('Nothing'));
  assert.ok(proposalAt > 0 && wordsAt >= 0 && lineAt >= 0);
  assert.ok(wordsAt < proposalAt && lineAt < proposalAt, 'both before the card');
  assert.equal(count(textOf(events), PREPARED_LINE), 1);
  assert.equal(textOf(events).includes('Sent!'), false);
});

test('a claim made in the same sentence as the true part keeps the true part', async () => {
  setOxwalModelClientForTesting(fakeModel([
    {
      content: [
        { type: 'text', text: 'I prepared the payment to Acme. Paid, and no further steps are needed. You can review it in Wallet.' },
        toolUse('t1', 'proposePayment', { orgId: 'demo-business', counterpartyId: 'cp_acme_ph', amountUsd: 600, currency: 'PHP' }),
      ],
    },
    { content: [{ type: 'text', text: '' }] },
  ]));
  const events = await turn({ message: 'Pay Acme 600 USD', orgId: 'demo-business', sessionKey: 's-guard-2', forceLocal: false });
  const text = textOf(events);
  assert.match(text, /I prepared the payment to Acme\./);
  assert.match(text, /You can review it in Wallet\./);
  assert.equal(text.includes('no further steps'), false);
  assert.equal(count(text, PREPARED_LINE), 1);
});

test('asked "did it go through?", a model that says yes is answered with what is true, and no approval is promised', async () => {
  setOxwalModelClientForTesting(fakeModel([{ content: [{ type: 'text', text: 'Yes, it was sent a few minutes ago.' }] }]));
  const events = await turn({ message: 'Did it go through?', orgId: 'demo-business', sessionKey: 's-guard-3', history: MONEY_HISTORY, forceLocal: false });
  const text = textOf(events);
  assert.equal(text.includes('it was sent'), false);
  assert.equal(count(text, PLAIN_LINE), 1);
  assert.equal(text.includes('waiting for approval'), false);
});

test('a turn that is not about money is never touched, whatever the model says', async () => {
  setOxwalModelClientForTesting(fakeModel([{ content: [{ type: 'text', text: 'Done! I will go by Ada from now on. Sent you my thanks.' }] }]));
  const events = await turn({ message: 'Call yourself Ada', orgId: 'demo-business', forceLocal: false });
  assert.equal(textOf(events), 'Done! I will go by Ada from now on. Sent you my thanks.');
  assert.equal(textOf(events).includes('Nothing has been sent'), false);
  assert.equal(textOf(events).includes("I haven't sent"), false);
});

test('a short reply with no money in the thread is not a money turn', async () => {
  setOxwalModelClientForTesting(fakeModel([{ content: [{ type: 'text', text: 'Done. Anything else?' }] }]));
  const events = await turn({
    message: 'yes, go ahead',
    orgId: 'demo-business',
    history: [{ role: 'user', content: 'Call yourself Ada' }, { role: 'assistant', content: 'Do you want me to go by Ada?' }],
    forceLocal: false,
  });
  assert.equal(textOf(events), 'Done. Anything else?');
});

test('a reply with no claim reaches the person word for word, with no extra line', async () => {
  const body = 'I prepared the payment to Acme. A teammate approves it in Wallet.';
  setOxwalModelClientForTesting(fakeModel([
    {
      content: [
        { type: 'text', text: body },
        toolUse('t1', 'proposePayment', { orgId: 'demo-business', counterpartyId: 'cp_acme_ph', amountUsd: 600, currency: 'PHP' }),
      ],
    },
    { content: [{ type: 'text', text: '' }] },
  ]));
  const events = await turn({ message: 'Pay Acme 600 USD', orgId: 'demo-business', sessionKey: 's-guard-6', forceLocal: false });
  const text = textOf(events);
  assert.ok(text.endsWith(body) || text.includes(body), 'the model\'s words are intact');
  assert.equal(text.includes('Nothing has been sent'), false, 'no claim, so no extra line');
  assert.equal(text.includes("I haven't sent"), false);
});

test('Zeke\'s own fixed words are never mistaken for a claim', async () => {
  for (const message of [
    'Pay invoice inv_demo_acme_5000 to cp_acme_ph',
    'Prepare a batch for this month',
    'Run payroll',
    'Allocate 2,500 of idle cash to treasury',
    'What are my balances right now?',
    'How do fees work?',
    'Hi Zeke',
    'Send 500 USDC to Manila Parts',
  ]) {
    const text = textOf(await turn({ message, orgId: 'demo-business', sessionKey: `s-fixed-${message.length}` }));
    assert.equal(text.includes(PREPARED_LINE), false, message);
    assert.equal(text.includes(PLAIN_LINE), false, message);
  }
});

test('two turns at once keep their own words: one is guarded, the other is not, and nothing crosses', async () => {
  setOxwalModelClientForTesting(fakeModel(async (params) => {
    const last = params.messages[params.messages.length - 1];
    const asked = typeof last.content === 'string' ? last.content : '';
    await new Promise((resolve) => setTimeout(resolve, asked.startsWith('Pay') ? 15 : 1));
    return { content: [{ type: 'text', text: asked.startsWith('Pay') ? 'Paid! It is done.' : 'Hello from the other business.' }] };
  }));
  const [a, b] = await Promise.all([
    turn({ message: 'Pay Acme 600 USD', orgId: 'org-a.test', forceLocal: false }),
    turn({ message: 'Summarise the situation for the board', orgId: 'org-b.test', forceLocal: false }),
  ]);
  assert.equal(textOf(b), 'Hello from the other business.');
  assert.equal(textOf(a).includes('Hello from'), false);
  assert.equal(textOf(a).includes('Paid!'), false);
  assert.equal(count(textOf(a), 'Nothing has been sent') + count(textOf(a), "I haven't sent anything"), 1);
});

test('the same turn replayed says the same thing, and the line is not stacked on a history that already has it', async () => {
  const run = async (history) => {
    setOxwalModelClientForTesting(fakeModel([{ content: [{ type: 'text', text: 'Paid!' }] }]));
    return textOf(await turn({ message: 'Did it go through?', orgId: 'demo-business', history, forceLocal: false }));
  };
  const first = await run(MONEY_HISTORY);
  const second = await run(MONEY_HISTORY);
  assert.equal(first, second);
  const third = await run([...MONEY_HISTORY, { role: 'assistant', content: PLAIN_LINE }]);
  assert.equal(count(third, PLAIN_LINE), 1, 'a line in the thread is not a reason to skip it or to repeat it');
});

test('the guard does not depend on the environment: production replaces claims too', () => {
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal(guard('Paid!').text, PREPARED_LINE);
    assert.equal(guard('It will be sent once approved.').replaced, false);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});

test('the prompt tells the model what the guard enforces', () => {
  assert.match(OXWAL_SYSTEM_PROMPT, /never say that money has been, was or is being sent, paid or transferred/i);
});
