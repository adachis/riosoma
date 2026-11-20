/** The zone this browser is in, which a visitor sees times in. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The day an instant falls on in a zone, as `YYYY-MM-DD`. */
export function dayIn(instant: string | number | Date, timeZone = localZone()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((piece) => piece.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** A time of day, as the reader's language writes one, in their own zone. */
export function timeOfDay(instant: string, locale: string, timeZone = localZone()): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(
    new Date(instant),
  );
}

/** A booked stretch of time, with its day, as the reader's language writes one. */
export function stretch(start: string, end: string, locale: string, timeZone = localZone()): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone }).formatRange(
    new Date(start),
    new Date(end),
  );
}

/** A time of day, `HH:MM`, as the reader's language writes one. */
export function clockLabel(at: string, locale: string): string {
  const [hours = 0, minutes = 0] = at.split(':').map(Number);
  if (hours === 24) return clockLabel('00:00', locale);
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(
    Date.UTC(2024, 0, 1, hours, minutes),
  );
}

/** A weekday's name, with 0 for Sunday as the settings count. */
export function weekdayName(day: number, locale: string): string {
  // The first of January 2023 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    Date.UTC(2023, 0, 1 + day),
  );
}

/** A day, `YYYY-MM-DD`, as the reader's language writes one. */
export function dayLabel(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${day}T12:00:00Z`),
  );
}
