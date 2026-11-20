import { isCurrencyCode } from './fields.js';
import type { MultiCurrencyValue } from './compound-values.js';

/** A wall clock never acquires a date or changes with the viewer's time zone. */
export function parseTimeOfDay(input: string, locale = 'en-US'): string | null {
  let text = input.trim().replace(/[\u200e\u200f\u061c]/g, '');
  if (!/^[\d:\sapm]+$/i.test(text)) {
    const digits = new Intl.NumberFormat(locale, { useGrouping: false });
    for (let digit = 0; digit < 10; digit++) text = text.replaceAll(digits.format(digit), String(digit));
    const periods = new Intl.DateTimeFormat(locale, { hour: 'numeric', hourCycle: 'h12', timeZone: 'UTC' });
    for (const [hour, suffix] of [
      [1, 'AM'],
      [13, 'PM'],
    ] as const) {
      const period = periods
        .formatToParts(new Date(Date.UTC(2000, 0, 1, hour)))
        .find((part) => part.type === 'dayPeriod')?.value;
      if (period && text.toLocaleLowerCase(locale).includes(period.toLocaleLowerCase(locale))) {
        text = text.toLocaleLowerCase(locale).replace(period.toLocaleLowerCase(locale), '').trim() + suffix;
        break;
      }
    }
  }
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?$/i.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (minute > 59 || second > 59) return null;
  if (match[4]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (match[4].toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hour > 23) return null;
  return [hour, minute, second].map((part) => String(part).padStart(2, '0')).join(':');
}

const clocks = new Map<string, Intl.DateTimeFormat>();

export function formatTimeOfDay(value: string, locale: string, format: 'local' | '12h' | '24h'): string {
  const parsed = parseTimeOfDay(value);
  if (!parsed) return '';
  const key = `${locale}|${format}`;
  let clock = clocks.get(key);
  if (!clock) {
    clock = new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'UTC',
      ...(format === 'local' ? {} : { hourCycle: format === '12h' ? 'h12' : 'h23' }),
    });
    if (clocks.size > 64) clocks.clear();
    clocks.set(key, clock);
  }
  return clock.format(new Date(`2000-01-01T${parsed}Z`));
}

/** Clipboard and text formulas retain the currency code so amounts stay unambiguous. */
export function multiCurrencyText(value: MultiCurrencyValue): string {
  return `${value.code} ${value.amount}`;
}

export function parseMultiCurrency(input: string, defaultCode?: string): MultiCurrencyValue | null {
  const match = /^([A-Z]{3})\s+(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.exec(input.trim());
  const bare = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(input.trim());
  const code = match?.[1]?.toUpperCase() ?? (bare ? defaultCode : undefined);
  if (!code) return null;
  const amount = Number(match ? match[2] : input.trim());
  return isCurrencyCode(code) && Number.isFinite(amount) ? { code, amount } : null;
}
