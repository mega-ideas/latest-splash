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
  ['Cyrillic look-alike P', 'Рaid!'],
  ['Cyrillic look-alike e', 'Sеnt!'],
  ['Cyrillic look-alike a in a sentence', 'I hаve sent it.'],
  ['Greek omicron', 'Dοne!'],
  ['full-width letters', 'Ｓｅｎｔ！'],
  ['math bold letters', '𝐏𝐚𝐢𝐝!'],
  ['circled letters', 'ⓟⓐⓘⓓ'],
  ['small caps', 'ᴘᴀɪᴅ!'],
  ['zero-width space inside', 'Pa​id!'],
  ['zero-width joiner and soft hyphen', 'I h‍ave s­ent it.'],
  ['spaced letters', 'P a i d !'],
  ['dotted letters', 'S.e.n.t.'],
  ['hyphenated letters', 'P-a-i-d!'],
  ['digits for letters', 'S3nt!'],
  ['digit four for a', 'P4id!'],
  ['zero for o', 'd0ne!'],
  ['stretched word', 'Paaaaid!'],
  ['stretched done', 'Dooooone!'],
  ['accents', 'Pàïd!'],
  ['combining marks', 'Páïd!'],
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
    assert.equal(out.text, PREPARED_LINE, label);
  }
});

const OTHER_LANGUAGES = [
  ['Indonesian', 'Pembayaran berhasil dikirim.'],
  ['Indonesian', 'Sudah saya kirim ke Acme.'],
  ['Indonesian', 'Sudah dibayar!'],
  ['Malay', 'Pembayaran telah dihantar.'],
  ['Tagalog', 'Naipadala na!'],
  ['Tagalog', 'Nabayaran na ang invoice.'],
  ['Vietnamese', 'Đã gửi tiền cho Acme.'],
  ['Vietnamese', 'Đã thanh toán xong.'],
  ['Thai', 'ส่งเงินแล้ว'],
  ['Thai', 'โอนเรียบร้อยแล้ว'],
  ['Chinese', '已转账给Acme。'],
  ['Chinese', '付款成功！'],
  ['Chinese', '已经发送了。'],
  ['Chinese', '搞定！'],
  ['Japanese', '送金しました。'],
  ['Japanese', '支払い済みです。'],
  ['Korean', '송금했습니다.'],
  ['Korean', '결제가 완료되었습니다.'],
  ['Spanish', 'Pago enviado.'],
  ['Spanish', 'Ya lo he enviado.'],
  ['Spanish', '¡Listo, he pagado a Acme!'],
  ['Spanish', 'La transferencia ha sido completada.'],
  ['French', "J'ai envoyé le paiement."],
  ['French', 'Paiement effectué.'],
  ['French', "C'est fait !"],
  ['Portuguese', 'Pagamento enviado.'],
  ['Portuguese', 'Já paguei o fornecedor.'],
  ['Portuguese', 'Transferência concluída.'],
  ['German', 'Ich habe das Geld überwiesen.'],
  ['German', 'Zahlung erfolgreich.'],
  ['German', 'Erledigt!'],
  ['Italian', 'Ho inviato il pagamento.'],
  ['Italian', 'Pagamento effettuato.'],
  ['Russian', 'Платёж отправлен.'],
  ['Russian', 'Я перевёл деньги.'],
  ['Russian', 'Готово!'],
  ['Arabic', 'تم الإرسال.'],
  ['Arabic', 'تم الدفع بنجاح.'],
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
  ZEKE_LIMITATION_TEXT.PAYMENT,
  ZEKE_LIMITATION_TEXT.BATCH,
  ZEKE_LIMITATION_TEXT.TREASURY,
  ZEKE_LIMITATION_TEXT.READ,
  ZEKE_FIRST_RECIPIENT_NUDGE,
  PREPARED_LINE,
  PLAIN_LINE,
  // Other languages, said truthfully.
  'Aún no se ha enviado nada.',
  "Rien n'a été envoyé.",
  'Belum dikirim, menunggu persetujuan.',
  '尚未发送，等待批准。',
  '承認されるまで送金されません。',
  'Nichts wurde gesendet.',
  'Nada foi enviado ainda.',
  'Ancora nulla è stato inviato.',
  'Пока ничего не отправлено.',
  'لم يتم إرسال أي شيء.',
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
  const strict = ['Send 500 USDC to Manila Parts', 'Pay Acme', 'Prepare a batch for this month', 'Run payroll'];
  for (const message of strict) assert.equal(level(message, []), 'strict', message);

  const topic = ['What did we pay last month?', 'Show me my receipts for payments', 'How do I pay a supplier in the Philippines?', 'Kirim 500 USDC ke Acme', '支付了多少？'];
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
  const events = await turn({ message: 'Call yourself Ada', orgId: 'demo-business', sessionKey: 's-guard-4', forceLocal: false });
  assert.equal(textOf(events), 'Done! I will go by Ada from now on. Sent you my thanks.');
  assert.equal(textOf(events).includes('Nothing has been sent'), false);
  assert.equal(textOf(events).includes("I haven't sent"), false);
});

test('a short reply with no money in the thread is not a money turn', async () => {
  setOxwalModelClientForTesting(fakeModel([{ content: [{ type: 'text', text: 'Done. Anything else?' }] }]));
  const events = await turn({
    message: 'yes, go ahead',
    orgId: 'demo-business',
    sessionKey: 's-guard-5',
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
    turn({ message: 'Pay Acme 600 USD', orgId: 'org-a.test', sessionKey: 's-a', forceLocal: false }),
    turn({ message: 'Hi there', orgId: 'org-b.test', sessionKey: 's-b', forceLocal: false }),
  ]);
  assert.equal(textOf(b), 'Hello from the other business.');
  assert.equal(textOf(a).includes('Hello from'), false);
  assert.equal(textOf(a).includes('Paid!'), false);
  assert.equal(count(textOf(a), 'Nothing has been sent') + count(textOf(a), "I haven't sent anything"), 1);
});

test('the same turn replayed says the same thing, and the line is not stacked on a history that already has it', async () => {
  const run = async (history) => {
    setOxwalModelClientForTesting(fakeModel([{ content: [{ type: 'text', text: 'Paid!' }] }]));
    return textOf(await turn({ message: 'Did it go through?', orgId: 'demo-business', sessionKey: 's-replay', history, forceLocal: false }));
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
