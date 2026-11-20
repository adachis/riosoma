import { isCurrencyCode } from '@riosoma/contracts';

/** Reading values that came from another tool. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A cell as plain text: names, file names, and email addresses rather than objects. */
export function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    const parts = value.map(textOf).filter((part): part is string => part !== null && part !== '');
    return parts.length ? parts.join(', ') : null;
  }
  if (isRecord(value)) {
    for (const key of ['error', 'specialValue', 'email', 'filename', 'text', 'value', 'label', 'name', 'id'])
      if (typeof value[key] === 'string') return value[key];
    return JSON.stringify(value);
  }
  return null;
}

const SYMBOLS: Readonly<Record<string, string>> = {
  $: 'USD',
  US$: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₩': 'KRW',
  '₽': 'RUB',
  R$: 'BRL',
  A$: 'AUD',
  AU$: 'AUD',
  C$: 'CAD',
  CA$: 'CAD',
  HK$: 'HKD',
  NZ$: 'NZD',
  S$: 'SGD',
  MX$: 'MXN',
  Mex$: 'MXN',
  CHF: 'CHF',
  zł: 'PLN',
  '₺': 'TRY',
  '₪': 'ILS',
  '฿': 'THB',
  '₫': 'VND',
  '₱': 'PHP',
  '₦': 'NGN',
  '₴': 'UAH',
  Kč: 'CZK',
  Ft: 'HUF',
  R: 'ZAR',
};

/** The currency a symbol stands for, or null when it could be several or none. */
export function currencyCode(symbol: string | undefined): string | null {
  const text = (symbol ?? '$').trim();
  const code = SYMBOLS[text] ?? text.toUpperCase();
  return isCurrencyCode(code) ? code : null;
}
