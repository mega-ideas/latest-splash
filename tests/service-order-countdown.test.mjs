import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The service-order countdown, as a person reads it.
 *
 * A ticking m:ss clock rewrites itself every second, which is constant motion
 * for someone who asked their system for less. Under prefers-reduced-motion
 * the words change once a minute instead, and the boundary still lands on
 * time because the contract's expires_at decides it, not the tick.
 *
 * When the window closes the card says so in a sentence: nothing was paid,
 * and what to do. It stops offering a signature the chain would refuse.
 */

const root = new URL('../', import.meta.url);
const source = (rel) => readFile(new URL(rel, root), 'utf8').then((text) => text.replace(/\r\n/g, '\n'));
const orders = () => import('../lib/sui/service-orders.ts');
const COMPONENT = 'components/service-orders/ServiceOrderSignatures.tsx';

test('under reduced motion the countdown words change once a minute, not every second', async () => {
  const { serviceOrderWindow, serviceOrderCountdownText } = await orders();
  const intent = { createdAtMs: 0, expiresAtMs: 600_000 };
  const at = (nowMs, reducedMotion) => serviceOrderCountdownText(serviceOrderWindow(intent, nowMs), { reducedMotion });

  // With motion, a second later is a different string.
  assert.notEqual(at(361_000, false), at(362_000, false));
  assert.match(at(361_000, false), /^3:59 left for a second approver to sign$/);

  // Without, every second of the same minute reads the same.
  const minute = new Set([361_000, 375_000, 399_000, 420_000].map((now) => at(now, true)));
  assert.equal(minute.size, 1, [...minute].join(' | '));
  assert.match([...minute][0], /^4 minutes left for a second approver to sign$/);
  assert.match(at(570_000, true), /^Under a minute left for a second approver to sign$/);
});

test('a closed window says nothing was paid and what to do next, with or without motion', async () => {
  const { serviceOrderWindow, serviceOrderCountdownText } = await orders();
  const closed = serviceOrderWindow({ createdAtMs: 0, expiresAtMs: 600_000 }, 600_000);
  for (const reducedMotion of [false, true]) {
    const text = serviceOrderCountdownText(closed, { reducedMotion });
    assert.match(text, /window closed/i);
    assert.match(text, /Nothing was paid/);
    assert.match(text, /Create the payment again/);
  }
});

test('the card reads prefers-reduced-motion and stops offering a signature once the window closes', async () => {
  const text = await source(COMPONENT);
  assert.match(text, /prefers-reduced-motion: reduce/, 'the countdown does not ask for reduced motion');
  assert.match(text, /serviceOrderCountdownText\(/, 'the countdown does not use the shared wording');
  assert.match(text, /const canSign = [^;]*expired/, 'a signature is still offered after the window closes');
  for (const match of text.matchAll(/className="[^"]*animate-pulse[^"]*"/g)) {
    assert.match(match[0], /motion-reduce:animate-none/, `${match[0]} pulses under reduced motion`);
  }
});

test('the closing of the window is announced once, not every tick', async () => {
  const text = await source(COMPONENT);
  // The ticking text is silent; a separate polite region carries the close.
  assert.match(text, /aria-live="off"/);
  assert.match(text, /aria-live="polite"[^>]*>\s*\{[^}]*expired/);
});
