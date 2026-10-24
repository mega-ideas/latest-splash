import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * v2 Phase 3, brief section 5.1: the dashboard navigation.
 *
 * Home · Zeke (AI) · Payments: Transfer, Batch payouts, Invoices · Money:
 * Wallet, Treasury · Contacts: Recipients, History · Settings · Support.
 * Rate holds and Send USDC leave the nav (their old URLs redirect), Account
 * setup shows until setup is complete and then sits under Settings, and
 * Treasury is no longer padlocked by the custody phase (D9: the treasury is
 * the business's own wallet, so there is no custody to wait for).
 *
 * The nav is data in lib/dashboard/nav.ts, with no I/O, so its order, its
 * locks and its current-page rule are tested here as behaviour rather than
 * as JSX text.
 */

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const nav = await import('../lib/dashboard/nav.ts');

const labels = (sections) => sections.flatMap((section) => section.items.map((item) => item.label));
const OPEN = { termsDone: true, moneyBlocked: false, custodyOn: false, reason: '' };

test('the nav reads Home, Zeke, Payments, Money, Contacts, then Settings and Support', () => {
  const view = nav.dashboardNav({ done: 4, total: 4, complete: true });
  assert.deepEqual(view.sections.map((section) => section.title), [null, 'Payments', 'Money', 'Contacts']);
  assert.deepEqual(labels(view.sections), [
    'Home', 'Zeke', 'Transfer', 'Batch payouts', 'Invoices', 'Wallet', 'Treasury', 'Recipients', 'History',
  ]);
  assert.deepEqual(view.utility.map((item) => item.label), ['Settings', 'Support']);
  const home = view.sections[0].items[0];
  assert.equal(home.href, '/dashboard');
  const zeke = view.sections[0].items[1];
  assert.equal(zeke.href, '/dashboard/zeke');
  assert.equal(zeke.badge, 'AI');
  assert.equal(view.sections[2].items[0].href, '/dashboard/wallet');
});

test('Rate holds and Send USDC are not in the nav', () => {
  const view = nav.dashboardNav(undefined);
  const every = [...view.sections.flatMap((s) => s.items), ...view.utility, ...view.utility.flatMap((i) => i.children ?? [])];
  for (const gone of ['Rate holds', 'Send USDC', 'Overview']) {
    assert.ok(!every.some((item) => item.label === gone), `${gone} is still in the nav`);
  }
  for (const href of ['/dashboard/transfers', '/dashboard/send-usdc', '/dashboard/overview', '/dashboard/copilot']) {
    assert.ok(!every.some((item) => item.href === href), `${href} is still linked from the nav`);
  }
});

test('Account setup shows on its own until setup is complete, then moves under Settings', () => {
  const pending = nav.dashboardNav({ done: 2, total: 4, complete: false });
  assert.deepEqual(pending.setup, { href: '/dashboard/setup', label: 'Account setup', done: 2, total: 4 });
  assert.equal(pending.utility[0].children, undefined, 'not under Settings while it is still to do');

  const complete = nav.dashboardNav({ done: 4, total: 4, complete: true });
  assert.equal(complete.setup, null);
  assert.deepEqual(complete.utility[0].children?.map((item) => [item.label, item.href]), [['Account setup', '/dashboard/setup']]);

  // Unreadable (no database on a dev machine): nothing to nag about, but the
  // page stays reachable under Settings.
  const unknown = nav.dashboardNav(undefined);
  assert.equal(unknown.setup, null);
  assert.equal(unknown.utility[0].children?.[0].href, '/dashboard/setup');
});

test('the current page is marked by path, and Home only on Home', () => {
  assert.equal(nav.isCurrent('/dashboard', '/dashboard'), true);
  assert.equal(nav.isCurrent('/dashboard', '/dashboard/zeke'), false, 'Home is not current on every page');
  assert.equal(nav.isCurrent('/dashboard/zeke', '/dashboard/zeke'), true);
  assert.equal(nav.isCurrent('/dashboard/history', '/dashboard/audit/pi_123'), true, 'a receipt belongs to History');
  assert.equal(nav.isCurrent('/dashboard/transfer', '/dashboard/transfers'), false, 'prefix match stops at a segment');
  assert.equal(nav.isCurrent('/dashboard/settings', '/dashboard/settings'), true);
});

test('Treasury is not padlocked by the custody phase any more (D9)', () => {
  assert.equal(nav.pageLock('/dashboard/treasury', { ...OPEN, custodyOn: false }, 'full'), null);
  // The KYB gate and the terms still apply to it, as to every money page.
  assert.equal(nav.pageLock('/dashboard/treasury', { ...OPEN, moneyBlocked: true, reason: 'Verify first.' }, 'full')?.reason, 'Verify first.');
  assert.match(nav.pageLock('/dashboard/treasury', { ...OPEN, termsDone: false }, 'full')?.reason ?? '', /Accept the terms/);
});

test('the locks keep parity with the routes: spend pages need KYB and terms, Wallet the terms', () => {
  for (const href of ['/dashboard/transfer', '/dashboard/batch']) {
    assert.equal(nav.pageLock(href, OPEN, 'full'), null);
    assert.equal(nav.pageLock(href, { ...OPEN, moneyBlocked: true, reason: 'KYB.' }, 'full')?.href, '/dashboard/setup');
    assert.equal(nav.pageLock(href, { ...OPEN, termsDone: false }, 'full')?.action, 'Finish account setup');
  }
  // The stablecoin lane is open to an unverified business (lib/payments/stablecoin-lane.ts).
  assert.equal(nav.pageLock('/dashboard/wallet', { ...OPEN, moneyBlocked: true, reason: 'KYB.' }, 'full'), null);
  assert.ok(nav.pageLock('/dashboard/wallet', { ...OPEN, termsDone: false }, 'full'));
  // Zeke and Home are reads: never locked.
  for (const href of ['/dashboard', '/dashboard/zeke']) {
    assert.equal(nav.pageLock(href, { termsDone: false, moneyBlocked: true, custodyOn: false, reason: 'x' }, 'full'), null);
  }
  // No database: nothing locks, mirroring the gates' own dev posture.
  assert.equal(nav.pageLock('/dashboard/transfer', undefined, 'full'), null);
});

test('a USDC-only launch sends the closed pages to Wallet, not to a removed page', () => {
  for (const href of ['/dashboard/transfer', '/dashboard/batch', '/dashboard/treasury']) {
    assert.deepEqual(nav.pageLock(href, OPEN, 'stablecoin')?.href, '/dashboard/wallet');
    assert.equal(nav.pageLock(href, OPEN, 'stablecoin')?.action, 'Open Wallet');
  }
});

test('the launch-scope sentence names a page that still exists', async () => {
  const rules = await source('lib/launch-scope-rules.ts');
  assert.doesNotMatch(rules, /from Send USDC/);
  assert.match(rules, /Send USDC from Wallet\./);
});

test('the old routes redirect: Rate holds, Send USDC (keeping its query), Overview and the copilot room', async () => {
  const transfers = await source('app/dashboard/transfers/page.tsx');
  assert.match(transfers, /redirect\('\/dashboard\/transfer'\)/);
  assert.doesNotMatch(transfers, /'use client'/, 'the rate-hold list is gone; quote holds stay in the backend');

  const sendUsdc = await source('app/dashboard/send-usdc/page.tsx');
  assert.match(sendUsdc, /redirect\(`\/dashboard\/wallet\$\{/, 'a Zeke handoff link keeps its prefilled recipient and amount');
  assert.match(sendUsdc, /searchParams/);

  const copilot = await source('app/dashboard/copilot/page.tsx');
  assert.match(copilot, /redirect\('\/dashboard\/zeke'\)/);

  const overview = await source('app/dashboard/overview/page.tsx');
  assert.match(overview, /redirect\('\/dashboard'\)/);
});

test('Wallet is today’s Send USDC page, Zeke has its own route, and Home is /dashboard', async () => {
  const wallet = await source('app/dashboard/wallet/page.tsx');
  assert.match(wallet, /<SendUsdcDesk \/>/);

  const zeke = await source('app/dashboard/zeke/page.tsx');
  assert.match(zeke, /useOxwalThread\(/);
  assert.match(zeke, /What's on the agenda today\?/);

  const home = await source('app/dashboard/page.tsx');
  assert.doesNotMatch(home, /useOxwalThread\(/, 'the Zeke desk moved to /dashboard/zeke');
  assert.match(home, /fetch\('\/api\/kyb\/state'/, 'Home carries today’s overview content');
});

test('every sign-in lands on Home', async () => {
  const login = await source('app/login/page.tsx');
  assert.match(login, /router\.push\('\/dashboard'\)/);
  const zk = await source('app/login/zklogin/callback/page.tsx');
  assert.match(zk, /router\.replace\('\/dashboard'\)/);
  assert.doesNotMatch(zk, /router\.replace\('\/settings\/kyb/);
});

test('links into the dashboard point at pages that exist under their new names', async () => {
  for (const file of [
    'app/queue/page.tsx',
    'components/queue/ApprovalQueueBoard.tsx',
    'components/invoices/InvoiceLoop.tsx',
    'app/dashboard/recipients/page.tsx',
  ]) {
    const text = await source(file);
    assert.doesNotMatch(text, /href="\/dashboard\/send-usdc"|'\/dashboard\/send-usdc'/, `${file} links the removed Send USDC page`);
  }
  // "Zeke" and "Back to Zeke" go to Zeke, which is no longer /dashboard.
  assert.match(await source('app/queue/page.tsx'), /href="\/dashboard\/zeke">Zeke</);
  assert.match(await source('components/queue/ApprovalQueueBoard.tsx'), /href="\/dashboard\/zeke"[\s\S]{0,200}Back to Zeke/);
  assert.match(await source('components/invoices/InvoiceLoop.tsx'), /href="\/dashboard\/zeke"[\s\S]{0,300}Chat/);
  // The floating Zeke stays out of the way on the Zeke page itself.
  assert.match(await source('components/FloatingCopilot.tsx'), /pathname !== '\/dashboard\/zeke'/);
});

test('the shell is keyboard and screen-reader navigable, with a real phone drawer', async () => {
  const shell = await source('components/dashboard/DashboardShell.tsx');
  assert.match(shell, /aria-label="Dashboard"/, 'the nav landmark is named');
  assert.match(shell, /aria-current=\{current \? 'page' : undefined\}/, 'the current page is announced');
  assert.match(shell, /href="#dashboard-content"/, 'a skip link reaches the page content');
  assert.match(shell, /id="dashboard-content"/);
  assert.match(shell, /min-h-11/, 'nav targets are at least 44px tall');
  assert.match(shell, /role="dialog"/, 'the phone menu is a dialog');
  assert.match(shell, /aria-modal="true"/);
  assert.match(shell, /event\.key === 'Escape'/, 'Escape closes the phone menu');
  assert.match(shell, /aria-controls="dashboard-drawer"/);
  // Collapsed rail: the label is still read out, not only a title tooltip.
  assert.match(shell, /<span className="sr-only">\{item\.label\}<\/span>/);
  // A padlocked link says so in words, not with an aria-disabled link that still navigates.
  assert.doesNotMatch(shell, /aria-disabled=/);
  assert.match(shell, /Locked:/);
});

test('the rail says Sui mainnet and carries no coral or testnet copy', async () => {
  const shell = await source('components/dashboard/DashboardShell.tsx');
  assert.match(shell, /Sui mainnet/);
  assert.doesNotMatch(shell, /testnet/i);
  assert.doesNotMatch(shell, /E39774|coral/i);
  // Colours come from the tokens wherever one exists.
  assert.doesNotMatch(shell, /#1F4452|#5C9EAD|#326273/i);
});
