import { NextResponse } from 'next/server';

import { getTreasuryRate } from '@/lib/server/usdy';

const sources = {
  bank: 'https://www.fdic.gov/national-rates-and-rate-caps',
  broker: 'https://www.interactivebrokers.com/en/accounts/fees/pricing-interest-rates.php?menu=A',
  wise: 'https://wise.com/us/interest/',
};

function plainText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * The first rate one of `patterns` reads from a source's own page, or null
 * when none does (the page was unreachable, or changed). A rate nobody read
 * is never stood in for by a remembered one: the landing shows "No
 * reading" (the A1 review).
 */
function firstRate(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const rate = Number(match[1]);
    if (Number.isFinite(rate)) return rate;
  }
  return null;
}

async function sourceText(url: string) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Splash Finance benchmark monitor/1.0' },
    next: { revalidate: 60 * 60 },
  });
  if (!response.ok) throw new Error(`Benchmark source returned ${response.status}`);
  return plainText(await response.text());
}

export async function GET() {
  const [bankResult, brokerResult, wiseResult] = await Promise.allSettled([
    sourceText(sources.bank),
    sourceText(sources.broker),
    sourceText(sources.wise),
  ]);

  const bankText = bankResult.status === 'fulfilled' ? bankResult.value : '';
  const brokerText = brokerResult.status === 'fulfilled' ? brokerResult.value : '';
  const wiseText = wiseResult.status === 'fulfilled' ? wiseResult.value : '';

  // Splash yield is the live, floating Ondo USDY net rate — never a fixed constant.
  const treasury = getTreasuryRate();

  return NextResponse.json({
    bank: firstRate(bankText, [/Savings\s+([0-9.]+)/i]),
    broker: firstRate(brokerText, [/USD\s+>\s*10,?000\s+([0-9.]+)%/i, /up to USD\s+([0-9.]+)%/i]),
    wise: firstRate(wiseText, [/([0-9.]+)% APY on USD/i, /USD\s+([0-9.]+)%/i]),
    splash: treasury.netApyPct,
    splashVariable: true,
    splashIntroductory: treasury.introductory,
    splashLabel: treasury.label,
    instrument: 'Ondo USDY (T-bill backed)',
    asOf: new Date().toISOString(),
    sources,
  });
}
