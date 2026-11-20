import { PaymentNotice } from '../../features/payments/PaymentNotice';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { I18nProvider as LocaleProvider } from 'react-aria-components';
import {
  BookingPageId,
  type BookingSlot,
  type CellValue,
  type PublicBookingPage,
  type PublicBookingResult,
} from '@riosoma/contracts';
import { DEFAULT_THEME, type ThemeChoice } from '@riosoma/tokens';
import { Button, Calendar, Radio, RadioGroup, Spinner } from '@riosoma/ui';
import { ApiError } from '../../api';
import { bookTime, readOpenTimes, readPublicBookingPage } from '../../features/booking-pages/api';
import { dayIn, localZone, stretch, timeOfDay } from '../../features/booking-pages/words';
import type { FormatContext } from '../../grid/format';
import { useServerMessage } from '../../messages/useServerMessage';
import { useTheme } from '../../shell/useAppliedTheme';
import { AnswerEditor } from '../database/views/form/AnswerEditor';
import { PublicLayout, questionField } from '../public-form/PublicFormScreen';
import '../database/record/RecordCard.css';
import '../public-form/public-form.css';
import './booking.css';

/**
 * The server refuses a ticket in its first 2 seconds, since only a script books that fast.  A
 * quick person's booking waits out the rest instead of failing.
 */
const TICKET_MIN_AGE_MS = 2_100;

type Booked = Extract<PublicBookingResult, { status: 'booked' }>;

/** A booking page, at `/b/:pageId`: anyone can book a time on it, signed in or not. */
export function BookingPageScreen() {
  const { pageId } = useParams({ from: '/b/$pageId' });
  return <BookingPageView pageId={pageId} />;
}

export function BookingPageView({ pageId }: { pageId: string }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const known = BookingPageId.safeParse(pageId).success;
  const page = useQuery({
    queryKey: ['public', 'bookings', pageId],
    queryFn: ({ signal }) => readPublicBookingPage(pageId, signal),
    enabled: known,
    // The ticket rides with the page, so a quiet refetch mustn't swap it while someone books.
    staleTime: Infinity,
  });
  const failure = page.error instanceof ApiError ? page.error.info : null;
  const missing = !known || failure?.code === 'not_found';
  const theme: ThemeChoice | null = page.data
    ? page.data.theme
      ? { theme: page.data.theme.id, scheme: page.data.theme.scheme }
      : DEFAULT_THEME
    : missing || page.isError
      ? DEFAULT_THEME
      : null;
  useTheme(theme);

  if (missing)
    return (
      <PublicLayout>
        <div className="rio-public-form__page rio-public-form__notice">
          <h1>
            {failure?.messageKey === 'bookings.public.off'
              ? message('bookings.public.off')
              : t({ id: 'bookings.page.unavailable', message: 'This booking page isn’t available.' })}
          </h1>
          <p>
            {t({
              id: 'bookings.page.unavailableHelp',
              message: 'It may have been turned off or deleted.  Check the link with whoever sent it.',
            })}
          </p>
        </div>
      </PublicLayout>
    );
  if (page.isError)
    return (
      <PublicLayout>
        <div className="rio-public-form__page rio-public-form__notice" role="alert">
          <p>{message(failure?.messageKey ?? 'errors.internal', failure?.params)}</p>
          <Button onPress={() => void page.refetch()}>
            {t({ id: 'boot.error.retry', message: 'Try again' })}
          </Button>
        </div>
      </PublicLayout>
    );
  if (!page.data)
    return (
      <PublicLayout>
        <div className="rio-public-form__page rio-public-form__notice">
          <Spinner />
        </div>
      </PublicLayout>
    );
  return <Booking key={pageId} page={page.data} loadedAt={page.dataUpdatedAt} />;
}

function empty(value: CellValue | undefined): boolean {
  return (
    value == null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** The first and last instants of a month in this browser's zone, for asking about its open times. */
function monthRange(month: string): { from: string; to: string } {
  const [year = 1970, number = 1] = month.split('-').map(Number);
  return {
    from: new Date(year, number - 1, 1).toISOString(),
    to: new Date(year, number, 1).toISOString(),
  };
}

function addDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function Booking({ page, loadedAt }: { page: PublicBookingPage; loadedAt: number }) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const queryClient = useQueryClient();
  const id = useId();
  const locale = i18n.locale || 'en-US';
  const [zone] = useState(localZone);
  const resources = page.resources;
  const [resource, setResource] = useState<string | null>(resources?.length === 1 ? resources[0]!.id : null);
  // A day away in either direction covers the page's zone being ahead of or behind this one.
  const [today] = useState(() => dayIn(Date.now(), localZone()));
  const first = page.firstDay > today ? addDays(page.firstDay, -1) : today;
  const last = addDays(page.lastDay, 1);
  const [month, setMonth] = useState(first.slice(0, 7));
  const [day, setDay] = useState<string | null>(null);
  // Bumped to open the calendar on a month chosen for it, such as the one of a time offered instead.
  const [calendarKey, setCalendarKey] = useState(0);
  const [slot, setSlot] = useState<BookingSlot | null>(null);
  const [answers, setAnswers] = useState<Record<string, CellValue>>({});
  const current = useRef(answers);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [taken, setTaken] = useState<BookingSlot[] | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [done, setDone] = useState<Booked | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const thanks = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLHeadingElement>(null);
  const focusDetails = useRef(false);
  const takenNotice = useRef<HTMLDivElement>(null);
  const trap = useRef<HTMLInputElement>(null);
  const format = useMemo<FormatContext>(
    () => ({ locale, timeZone: zone, collaborators: new Map() }),
    [locale, zone],
  );
  const questions = useMemo(
    () =>
      page.questions.flatMap((question) => {
        const field = questionField(question);
        return field ? [{ question, field }] : [];
      }),
    [page.questions],
  );
  const ready = !resources || resource !== null;
  const slotsKey = ['public', 'bookings', page.pageId, 'slots', resource, month] as const;
  const open = useQuery({
    queryKey: slotsKey,
    queryFn: ({ signal }) => readOpenTimes(page.pageId, { ...monthRange(month), resource }, signal),
    enabled: ready,
  });
  const byDay = useMemo(() => {
    const days = new Map<string, BookingSlot[]>();
    for (const item of open.data?.slots ?? []) {
      const key = dayIn(item.start, zone);
      days.set(key, [...(days.get(key) ?? []), item]);
    }
    return days;
  }, [open.data, zone]);
  const times = day ? (byDay.get(day) ?? []) : [];
  const required = t({ id: 'form.requiredMissing', message: 'Answer this question.' });
  const chosen = slot ? stretch(slot.start, slot.end, locale, zone) : '';

  useEffect(() => {
    const previous = document.title;
    document.title = page.title;
    return () => {
      document.title = previous;
    };
  }, [page.title]);
  useEffect(() => {
    if (done) thanks.current?.focus();
  }, [done]);
  useEffect(() => {
    if (taken) takenNotice.current?.focus();
  }, [taken]);
  useEffect(() => {
    if (!slot || !focusDetails.current) return;
    focusDetails.current = false;
    details.current?.focus();
  }, [slot]);

  function answer(fieldId: string, value: CellValue) {
    if (inFlight.current) return;
    current.current = { ...current.current, [fieldId]: value };
    setAnswers(current.current);
    setErrors((previous) => ({ ...previous, [fieldId]: '' }));
  }

  function pickSlot(next: BookingSlot, offered = false) {
    const nextDay = dayIn(next.start, zone);
    if (offered) {
      // The button pressed goes away with the list, so the details take the focus.
      focusDetails.current = true;
      if (nextDay.slice(0, 7) !== month) setCalendarKey((value) => value + 1);
    }
    setDay(nextDay);
    setMonth(nextDay.slice(0, 7));
    setSlot(next);
    setTaken(null);
    setError('');
  }

  function focusQuestion(fieldId: string) {
    document.getElementById(`${id}-${fieldId}`)?.focus();
  }

  async function submit() {
    if (inFlight.current || !slot) return;
    // Editors commit on blur, so commit the one in use before reading answers.
    flushSync(() => {
      if (document.activeElement instanceof HTMLElement && form.current?.contains(document.activeElement))
        document.activeElement.blur();
    });
    const invalid = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([role="group"])');
    if (invalid) {
      invalid.focus();
      return;
    }
    const missing = Object.fromEntries(
      questions
        .filter(({ question }) => question.required && empty(current.current[question.fieldId]))
        .map(({ question }) => [question.fieldId, required]),
    );
    setErrors(missing);
    setError('');
    const firstMissing = Object.keys(missing)[0];
    if (firstMissing) {
      focusQuestion(firstMissing);
      return;
    }
    const values = Object.fromEntries(
      questions
        .filter(({ question }) => !empty(current.current[question.fieldId]))
        .map(({ question }) => [question.fieldId, current.current[question.fieldId]!]),
    );
    inFlight.current = true;
    setPending(true);
    try {
      const wait = loadedAt + TICKET_MIN_AGE_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const result = await bookTime(page.pageId, {
        ticket: page.ticket,
        start: slot.start,
        ...(resource ? { resource } : {}),
        values,
        timeZone: zone,
        locale,
        website: trap.current?.value ?? '',
      });
      if (result.status === 'booked' && result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      if (result.status === 'booked') setDone(result);
      else {
        setSlot(null);
        setTaken(result.next);
        void queryClient.invalidateQueries({ queryKey: ['public', 'bookings', page.pageId, 'slots'] });
      }
    } catch (reason) {
      const info = reason instanceof ApiError ? reason.info : null;
      const fieldId = info?.params?.fieldId;
      if (
        info?.messageKey === 'bookings.public.required' &&
        typeof fieldId === 'string' &&
        questions.some(({ question }) => question.fieldId === fieldId)
      ) {
        setErrors({ [fieldId]: required });
        focusQuestion(fieldId);
      } else setError(message(info?.messageKey ?? 'errors.internal', info?.params));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const email = answers[page.emailFieldId];

  return (
    <PublicLayout>
      <LocaleProvider locale={locale}>
        <form
          ref={form}
          className="rio-public-form__page rio-booking"
          noValidate
          aria-labelledby={`${id}-title`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <header>
            <h1 id={`${id}-title`}>{page.title}</h1>
            {page.description && <p className="rio-public-form__description">{page.description}</p>}
          </header>
          <PaymentNotice payment={page.payment} />
          {done ? (
            <div ref={thanks} tabIndex={-1} className="rio-public-form__thanks" role="status">
              <h2 className="rio-booking__heading">
                {t({ id: 'bookings.page.booked', message: 'You’re booked' })}
              </h2>
              <p className="rio-booking__when">{stretch(done.start, done.end, locale, zone)}</p>
              {done.resource ? <p>{done.resource.name}</p> : null}
              {done.confirmation ? <p>{done.confirmation}</p> : null}
              {done.emailed && typeof email === 'string' ? (
                <p>
                  {t({
                    id: 'bookings.page.emailed',
                    message: `A confirmation with a calendar invitation is on its way to ${email}.  It has a link to cancel.`,
                  })}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              {resources ? (
                <RadioGroup
                  className="rio-booking__resources"
                  label={t({ id: 'bookings.page.resource', message: 'What would you like to book?' })}
                  value={resource}
                  isDisabled={pending}
                  onChange={(value) => {
                    setResource(value);
                    setDay(null);
                    setSlot(null);
                    setTaken(null);
                  }}
                >
                  {resources.map((item) => (
                    <Radio key={item.id} value={item.id}>
                      {item.name}
                    </Radio>
                  ))}
                </RadioGroup>
              ) : null}
              {ready ? (
                <section className="rio-booking__when-picker" aria-labelledby={`${id}-when`}>
                  <h2 id={`${id}-when`} className="rio-booking__heading">
                    {t({ id: 'bookings.page.when', message: 'Choose a time' })}
                  </h2>
                  <p className="rio-public-form__help">
                    {t({
                      id: 'bookings.page.zone',
                      message: `Times are shown in your time zone, ${zone}.`,
                    })}
                  </p>
                  <div className="rio-booking__picker">
                    <Calendar
                      key={calendarKey}
                      aria-label={t({ id: 'bookings.page.day', message: 'Day' })}
                      className="rio-booking__calendar"
                      value={day}
                      minValue={first}
                      maxValue={last}
                      isDisabled={pending}
                      isDateUnavailable={(value) => !byDay.has(value)}
                      onFocusChange={(value) => setMonth(value.toString().slice(0, 7))}
                      onChange={(value) => {
                        setDay(value);
                        setSlot(null);
                        setTaken(null);
                      }}
                    />
                    <div className="rio-booking__times" aria-live="polite">
                      {open.isPending ? (
                        <Spinner
                          size="sm"
                          label={t({ id: 'bookings.page.loading', message: 'Finding open times' })}
                        />
                      ) : open.isError ? (
                        <div role="alert">
                          <p>{message('errors.internal')}</p>
                          <Button size="sm" onPress={() => void open.refetch()}>
                            {t({ id: 'boot.error.retry', message: 'Try again' })}
                          </Button>
                        </div>
                      ) : !day ? (
                        <p className="rio-public-form__help">
                          {byDay.size
                            ? t({
                                id: 'bookings.page.pickDay',
                                message: 'Choose a day with open times.',
                              })
                            : t({
                                id: 'bookings.page.noneThisMonth',
                                message: 'No open times this month.  Try the next one.',
                              })}
                        </p>
                      ) : times.length ? (
                        <RadioGroup
                          className="rio-booking__slots"
                          orientation="horizontal"
                          label={t({ id: 'bookings.page.time', message: 'Time' })}
                          value={slot?.start ?? null}
                          isDisabled={pending}
                          onChange={(value) => {
                            const next = times.find((item) => item.start === value);
                            if (next) pickSlot(next);
                          }}
                        >
                          {times.map((item) => (
                            <Radio key={item.start} value={item.start}>
                              {timeOfDay(item.start, locale, zone)}
                            </Radio>
                          ))}
                        </RadioGroup>
                      ) : (
                        <p className="rio-public-form__help">
                          {t({ id: 'bookings.page.noneThatDay', message: 'No open times that day.' })}
                        </p>
                      )}
                    </div>
                  </div>
                </section>
              ) : null}
              {taken ? (
                <div ref={takenNotice} tabIndex={-1} role="alert" className="rio-booking__taken">
                  <p>
                    {t({
                      id: 'bookings.page.taken',
                      message: 'Someone just took that time.  Here are the next open times.',
                    })}
                  </p>
                  {taken.length ? (
                    <ul className="rio-booking__next">
                      {taken.map((item) => (
                        <li key={item.start}>
                          <Button size="sm" onPress={() => pickSlot(item, true)}>
                            {stretch(item.start, item.end, locale, zone)}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>
                      {t({
                        id: 'bookings.page.noneNext',
                        message: 'There are no open times soon after it.  Choose another day.',
                      })}
                    </p>
                  )}
                </div>
              ) : null}
              {slot ? (
                <section aria-labelledby={`${id}-details`} className="rio-booking__details">
                  <h2 id={`${id}-details`} ref={details} tabIndex={-1} className="rio-booking__heading">
                    {t({ id: 'bookings.page.details', message: 'Your details' })}
                  </h2>
                  <p className="rio-booking__when">{chosen}</p>
                  {questions.map(({ question, field }) => {
                    const questionId = `${id}-${question.fieldId}`;
                    return (
                      <section
                        key={question.fieldId}
                        id={questionId}
                        tabIndex={-1}
                        role="group"
                        aria-labelledby={`${questionId}-label`}
                        aria-describedby={`${questionId}-required ${questionId}-validation`}
                        aria-invalid={Boolean(errors[question.fieldId])}
                        className="rio-public-form__question"
                      >
                        <div className="rio-public-form__question-heading">
                          <span id={`${questionId}-label`}>{question.label}</span>
                          <span id={`${questionId}-required`} className="rio-public-form__required">
                            {question.required ? t({ id: 'form.required', message: 'Required' }) : ''}
                          </span>
                        </div>
                        <fieldset disabled={pending} className="rio-public-form__editor">
                          <AnswerEditor
                            key={field.type}
                            field={field}
                            value={answers[field.id] ?? null}
                            format={format}
                            labelId={`${questionId}-label`}
                            onChange={answer}
                          />
                        </fieldset>
                        <div
                          id={`${questionId}-validation`}
                          className="rio-public-form__error"
                          aria-live="polite"
                        >
                          {errors[question.fieldId]}
                        </div>
                      </section>
                    );
                  })}
                  {/* People never see or reach this field.  Scripts that fill in every input give themselves away. */}
                  <div className="rio-public-form__trap" aria-hidden="true">
                    <input
                      ref={trap}
                      type="text"
                      name="website"
                      tabIndex={-1}
                      autoComplete="off"
                      defaultValue=""
                    />
                  </div>
                  <div className="rio-public-form__error" role="alert">
                    {error}
                  </div>
                  <Button
                    type="submit"
                    variant="primary"
                    isPending={pending}
                    className="rio-public-form__submit"
                  >
                    {t({ id: 'bookings.page.book', message: 'Book this time' })}
                  </Button>
                </section>
              ) : null}
            </>
          )}
        </form>
      </LocaleProvider>
    </PublicLayout>
  );
}
