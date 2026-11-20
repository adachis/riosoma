import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** A clock that ticks once a minute, enough for relative times without re-rendering every second. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * "3 hours ago" or "yesterday" in the reader's language, in the largest whole unit.  Anything under
 * a minute, including a server clock slightly ahead of this one, reads "just now".
 */
export function useRelativeTime(iso: string): string {
  const { t, i18n } = useLingui();
  const now = useMinuteClock();
  const seconds = (Date.parse(iso) - now) / 1000;
  const match = UNITS.find(([, size]) => Math.abs(seconds) >= size);
  if (!match || seconds > 0) return t({ id: 'time.justNow', message: 'just now' });
  const [unit, size] = match;
  // Truncate so 59 minutes never rounds up to "60 minutes ago".
  return new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' }).format(
    Math.trunc(seconds / size),
    unit,
  );
}
