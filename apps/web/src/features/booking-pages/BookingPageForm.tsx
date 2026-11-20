import { PaymentPageSettings } from '../payments/PaymentPageSettings';
import { PublicThemePicker } from '../themes/PublicThemePicker';
import { anchor } from '../../demos/anchors';
import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  BOOKING_LIMITS,
  isBookingQuestionType,
  LIMITS,
  minutesOf,
  type BookingPage,
  type BookingPageInput,
  type BookingPageSettings,
  type FieldMeta,
  type OpenInterval,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  ComboBox,
  DatePicker,
  DialogBody,
  DialogFooter,
  Form,
  ListBoxItem,
  NumberField,
  Select,
  Switch,
  TextArea,
  TextField,
} from '@riosoma/ui';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { createBookingPage, saveBookingPage } from './api';
import { clockLabel, dayLabel, localZone, weekdayName } from './words';

/** A date field with a time, or a date range field with times. */
export function isTimeField(field: FieldMeta): boolean {
  return (field.type === 'date' || field.type === 'dateRange') && field.options.includeTime;
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const NO_RESOURCE = 'none';

/** Every half hour of a day, `00:00` to `24:00`, plus any saved time between them. */
function clockTimes(...current: string[]): string[] {
  const times = Array.from({ length: 49 }, (_, index) =>
    [Math.floor(index / 2), index % 2 ? 30 : 0].map((part) => String(part).padStart(2, '0')).join(':'),
  );
  for (const time of current) if (!times.includes(time)) times.push(time);
  return times.sort();
}

/** New settings for a table, with the first fields that fit and weekday office hours. */
export function startingSettings(fields: readonly FieldMeta[], title: string): BookingPageSettings {
  const weekday: OpenInterval[] = [{ start: '09:00', end: '17:00' }];
  return {
    title,
    description: '',
    timeFieldId: fields.find(isTimeField)?.id ?? '',
    resourceFieldId: null,
    lengthMinutes: 30,
    bufferMinutes: 0,
    timeZone: localZone(),
    hours: [[], weekday, weekday, weekday, weekday, weekday, []],
    blockedDays: [],
    maxDaysAhead: 60,
    minNoticeMinutes: 60,
    places: 1,
    nameFieldId: fields.find((field) => field.type === 'text')?.id ?? '',
    emailFieldId: fields.find((field) => field.type === 'email')?.id ?? '',
    questions: [],
    confirmation: '',
    dailyPerEmail: 3,
  };
}

/** Whether every day's hours end after they start, in order and without overlapping. */
function hoursValid(hours: BookingPageSettings['hours']): boolean {
  return hours.every((intervals) =>
    intervals.every(
      (interval, index) =>
        minutesOf(interval.start) < minutesOf(interval.end) &&
        (index === 0 || minutesOf(intervals[index - 1]!.end) <= minutesOf(interval.start)),
    ),
  );
}

export interface BookingPageFormProps {
  tableId: string;
  tableName: string;
  fields: readonly FieldMeta[];
  /** The page to change, or none for a new one */
  page?: BookingPage;
  onCancel(): void;
  onSaved(page: BookingPage): void;
}

/** Everything a booking page asks and allows, for setting one up or changing it. */
export function BookingPageForm({
  tableId,
  tableName,
  fields,
  page,
  onCancel,
  onSaved,
}: BookingPageFormProps) {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || 'en-US';
  const top = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<BookingPageSettings>(
    () => page?.settings ?? startingSettings(fields, tableName),
  );
  const [enabled, setEnabled] = useState(page?.enabled ?? true);
  const [blocking, setBlocking] = useState<string | null>(null);
  const [zones] = useState(() => Intl.supportedValuesOf('timeZone'));
  const [attempted, setAttempted] = useState(false);
  const save = useMutation({
    mutationFn: (body: BookingPageInput) =>
      page ? saveBookingPage(page.pageId, body) : createBookingPage(tableId, body),
    onSuccess: onSaved,
  });
  const pending = save.isPending;
  const change = (patch: Partial<BookingPageSettings>) =>
    setSettings((current) => ({ ...current, ...patch }));

  useEffect(() => {
    const frame = requestAnimationFrame(() => top.current?.querySelector('input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const timeFields = fields.filter(isTimeField);
  const textFields = fields.filter((field) => field.type === 'text');
  const emailFields = fields.filter((field) => field.type === 'email');
  const selectFields = fields.filter(
    (field) => field.type === 'singleSelect' && field.options.choices.length > 0,
  );
  const special = new Set(
    [settings.timeFieldId, settings.resourceFieldId, settings.nameFieldId, settings.emailFieldId].filter(
      Boolean,
    ),
  );
  const askable = fields.filter((field) => isBookingQuestionType(field.type) && !special.has(field.id));
  const asked = new Map(settings.questions.map((question) => [question.fieldId, question.required]));
  const missingFields = !timeFields.length || !textFields.length || !emailFields.length;
  const noTitle = settings.title.trim() === '';
  const badHours = !hoursValid(settings.hours);

  function submit() {
    setAttempted(true);
    if (noTitle || badHours || missingFields || pending) return;
    save.mutate({
      settings: {
        ...settings,
        title: settings.title.trim(),
        // Questions on fields since chosen for something else are dropped, as saving would refuse them.
        questions: settings.questions.filter((question) => !special.has(question.fieldId)),
      },
      enabled,
    });
  }

  function setHours(day: number, intervals: OpenInterval[]) {
    change({ hours: settings.hours.map((current, index) => (index === day ? intervals : current)) });
  }

  const fieldItems = (list: readonly FieldMeta[]) =>
    list.map((field) => (
      <ListBoxItem key={field.id} id={field.id} textValue={field.name}>
        {field.name}
      </ListBoxItem>
    ));

  return (
    <Form
      className="rio-booking-pages__form"
      validationBehavior="aria"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogBody>
        <div className="rio-booking-pages__fields" ref={top}>
          {missingFields ? (
            <Banner tone="warning">
              {t({
                id: 'bookings.form.missingFields',
                message:
                  'A booking page needs a date field that includes a time, a text field for names, and an email field.  Add the ones this table is missing first.',
              })}
            </Banner>
          ) : null}
          <TextField
            label={t({ id: 'bookings.form.title', message: 'Title' })}
            value={settings.title}
            onChange={(title) => change({ title })}
            maxLength={LIMITS.nameLength}
            isRequired
            isDisabled={pending}
            isInvalid={attempted && noTitle}
            errorMessage={t({ id: 'bookings.form.title.missing', message: 'Give the page a title.' })}
          />
          <TextArea
            label={t({ id: 'bookings.form.description', message: 'Description' })}
            value={settings.description}
            onChange={(description) => change({ description })}
            maxLength={2_000}
            isDisabled={pending}
          />
          <PublicThemePicker
            value={settings.theme ?? null}
            onChange={(theme) => change({ theme })}
            isDisabled={pending}
            anchorProps={anchor('bookings.theme')}
          />
          <Switch isSelected={enabled} onChange={setEnabled} isDisabled={pending}>
            {t({ id: 'bookings.form.enabled', message: 'Take bookings' })}
          </Switch>

          <fieldset className="rio-booking-pages__group">
            <legend>{t({ id: 'bookings.form.what', message: 'What people book' })}</legend>
            <Select
              label={t({ id: 'bookings.form.timeField', message: 'Time field' })}
              description={t({
                id: 'bookings.form.timeField.description',
                message: 'A date field that includes a time, or a date range field that includes times.',
              })}
              selectedKey={settings.timeFieldId || null}
              isDisabled={pending}
              onSelectionChange={(key) => {
                if (key !== null) change({ timeFieldId: String(key) });
              }}
            >
              {fieldItems(timeFields)}
            </Select>
            <Select
              label={t({ id: 'bookings.form.resource', message: 'Open to' })}
              description={t({
                id: 'bookings.form.resource.description',
                message:
                  'A single select of rooms, people, or equipment.  The booker picks one first, and each is booked on its own.',
              })}
              selectedKey={settings.resourceFieldId ?? NO_RESOURCE}
              isDisabled={pending}
              onSelectionChange={(key) =>
                change({ resourceFieldId: key === null || key === NO_RESOURCE ? null : String(key) })
              }
            >
              <ListBoxItem id={NO_RESOURCE}>
                {t({ id: 'bookings.form.resource.none', message: 'One calendar for everything' })}
              </ListBoxItem>
              {fieldItems(selectFields)}
            </Select>
            <div className="rio-booking-pages__row">
              <NumberField
                label={t({ id: 'bookings.form.length', message: 'Length, in minutes' })}
                value={settings.lengthMinutes}
                minValue={BOOKING_LIMITS.minLength}
                maxValue={BOOKING_LIMITS.maxLength}
                step={5}
                isDisabled={pending}
                onChange={(value) => {
                  if (Number.isFinite(value)) change({ lengthMinutes: value });
                }}
              />
              <NumberField
                label={t({ id: 'bookings.form.buffer', message: 'Buffer, in minutes' })}
                description={t({
                  id: 'bookings.form.buffer.description',
                  message: 'Kept free before and after every booking.',
                })}
                value={settings.bufferMinutes}
                minValue={0}
                maxValue={BOOKING_LIMITS.maxBuffer}
                step={5}
                isDisabled={pending}
                onChange={(value) => {
                  if (Number.isFinite(value)) change({ bufferMinutes: value });
                }}
              />
              <NumberField
                label={t({ id: 'bookings.form.places', message: 'Places per time' })}
                description={t({
                  id: 'bookings.form.places.description',
                  message: 'One for appointments, more for a class.',
                })}
                value={settings.places}
                minValue={1}
                maxValue={BOOKING_LIMITS.maxPlaces}
                isDisabled={pending}
                onChange={(value) => {
                  if (Number.isFinite(value)) change({ places: value });
                }}
              />
            </div>
          </fieldset>

          <fieldset className="rio-booking-pages__group">
            <legend>{t({ id: 'bookings.form.hours', message: 'Opening hours' })}</legend>
            <ComboBox
              label={t({ id: 'bookings.form.timeZone', message: 'Time zone' })}
              description={t({
                id: 'bookings.form.timeZone.description',
                message: 'Visitors see times in their own zone.',
              })}
              selectedKey={settings.timeZone}
              isDisabled={pending}
              onSelectionChange={(key) => {
                if (key !== null) change({ timeZone: String(key) });
              }}
            >
              {(zones.includes(settings.timeZone) ? zones : [settings.timeZone, ...zones]).map((zone) => (
                <ListBoxItem key={zone} id={zone} textValue={zone}>
                  {zone}
                </ListBoxItem>
              ))}
            </ComboBox>
            {WEEKDAYS.map((day) => {
              const weekday = weekdayName(day, locale);
              const intervals = settings.hours[day] ?? [];
              return (
                <div key={day} className="rio-booking-pages__day">
                  <Switch
                    isSelected={intervals.length > 0}
                    isDisabled={pending}
                    onChange={(on) => setHours(day, on ? [{ start: '09:00', end: '17:00' }] : [])}
                  >
                    {weekday}
                  </Switch>
                  {intervals.map((interval, index) => (
                    <div key={index} className="rio-booking-pages__interval">
                      <Select
                        size="sm"
                        aria-label={t({ id: 'bookings.form.opens', message: `${weekday} opens` })}
                        selectedKey={interval.start}
                        isDisabled={pending}
                        onSelectionChange={(key) => {
                          if (key !== null)
                            setHours(
                              day,
                              intervals.map((item, at) =>
                                at === index ? { ...item, start: String(key) } : item,
                              ),
                            );
                        }}
                      >
                        {clockTimes(interval.start)
                          .filter((time) => time !== '24:00')
                          .map((time) => (
                            <ListBoxItem key={time} id={time}>
                              {clockLabel(time, locale)}
                            </ListBoxItem>
                          ))}
                      </Select>
                      <Select
                        size="sm"
                        aria-label={t({ id: 'bookings.form.closes', message: `${weekday} closes` })}
                        selectedKey={interval.end}
                        isDisabled={pending}
                        onSelectionChange={(key) => {
                          if (key !== null)
                            setHours(
                              day,
                              intervals.map((item, at) =>
                                at === index ? { ...item, end: String(key) } : item,
                              ),
                            );
                        }}
                      >
                        {clockTimes(interval.end)
                          .filter((time) => time !== '00:00')
                          .map((time) => (
                            <ListBoxItem key={time} id={time}>
                              {clockLabel(time, locale)}
                            </ListBoxItem>
                          ))}
                      </Select>
                      <Button
                        variant="quiet"
                        size="sm"
                        icon={faXmark}
                        isDisabled={pending}
                        aria-label={t({
                          id: 'bookings.form.removeHours',
                          message: `Remove these hours on ${weekday}`,
                        })}
                        onPress={() =>
                          setHours(
                            day,
                            intervals.filter((_, at) => at !== index),
                          )
                        }
                      />
                    </div>
                  ))}
                  {intervals.length > 0 && intervals.length < BOOKING_LIMITS.intervalsPerDay ? (
                    <Button
                      size="sm"
                      isDisabled={pending}
                      aria-label={t({ id: 'bookings.form.addHoursOn', message: `Add hours on ${weekday}` })}
                      onPress={() => {
                        const last = intervals[intervals.length - 1]!;
                        const start = Math.min(minutesOf(last.end) + 60, 23 * 60);
                        const at = (minutes: number) =>
                          `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
                        setHours(day, [
                          ...intervals,
                          { start: at(start), end: at(Math.min(start + 60, 24 * 60)) },
                        ]);
                      }}
                      icon={faPlus}
                    />
                  ) : null}
                </div>
              );
            })}
            {attempted && badHours ? (
              <p className="rio-booking-pages__problem" role="alert">
                {t({
                  id: 'bookings.form.hours.invalid',
                  message: 'Each day’s hours have to end after they start, in order and without overlapping.',
                })}
              </p>
            ) : null}
          </fieldset>

          <fieldset className="rio-booking-pages__group">
            <legend>{t({ id: 'bookings.form.when', message: 'When people can book' })}</legend>
            <div className="rio-booking-pages__row">
              <NumberField
                label={t({ id: 'bookings.form.ahead', message: 'Days ahead' })}
                description={t({
                  id: 'bookings.form.ahead.description',
                  message: 'How far after today people can book.',
                })}
                value={settings.maxDaysAhead}
                minValue={0}
                maxValue={BOOKING_LIMITS.maxDaysAhead}
                isDisabled={pending}
                onChange={(value) => {
                  if (Number.isFinite(value)) change({ maxDaysAhead: value });
                }}
              />
              <NumberField
                label={t({ id: 'bookings.form.notice', message: 'Notice, in hours' })}
                description={t({
                  id: 'bookings.form.notice.description',
                  message: 'How long before a time people have to book it.',
                })}
                value={settings.minNoticeMinutes / 60}
                minValue={0}
                maxValue={BOOKING_LIMITS.maxNotice / 60}
                isDisabled={pending}
                onChange={(value) => {
                  if (Number.isFinite(value)) change({ minNoticeMinutes: Math.round(value * 60) });
                }}
              />
            </div>
            <div className="rio-booking-pages__blocked">
              <DatePicker
                label={t({ id: 'bookings.form.block', message: 'Block off a day' })}
                value={blocking}
                onChange={setBlocking}
                isDisabled={pending || settings.blockedDays.length >= BOOKING_LIMITS.blockedDays}
              />
              <Button
                size="sm"
                isDisabled={pending || !blocking}
                onPress={() => {
                  if (!blocking) return;
                  change({ blockedDays: [...new Set([...settings.blockedDays, blocking])].sort() });
                  setBlocking(null);
                }}
              >
                {t({ id: 'bookings.form.block.add', message: 'Block this day' })}
              </Button>
            </div>
            {settings.blockedDays.length ? (
              <ul
                className="rio-booking-pages__days"
                aria-label={t({ id: 'bookings.form.blocked', message: 'Blocked days' })}
              >
                {settings.blockedDays.map((day) => {
                  const label = dayLabel(day, locale);
                  return (
                    <li key={day}>
                      <span>{label}</span>
                      <Button
                        variant="quiet"
                        size="sm"
                        icon={faXmark}
                        isDisabled={pending}
                        aria-label={t({ id: 'bookings.form.unblock', message: `Open ${label} again` })}
                        onPress={() =>
                          change({ blockedDays: settings.blockedDays.filter((item) => item !== day) })
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </fieldset>

          <fieldset className="rio-booking-pages__group">
            <legend>{t({ id: 'bookings.form.questions', message: 'What the booker fills in' })}</legend>
            <div className="rio-booking-pages__row">
              <Select
                label={t({ id: 'bookings.form.nameField', message: 'Name field' })}
                selectedKey={settings.nameFieldId || null}
                isDisabled={pending}
                onSelectionChange={(key) => {
                  if (key !== null) change({ nameFieldId: String(key) });
                }}
              >
                {fieldItems(textFields)}
              </Select>
              <Select
                label={t({ id: 'bookings.form.emailField', message: 'Email field' })}
                description={t({
                  id: 'bookings.form.emailField.description',
                  message: 'The confirmation and its cancel link go to this address.',
                })}
                selectedKey={settings.emailFieldId || null}
                isDisabled={pending}
                onSelectionChange={(key) => {
                  if (key !== null) change({ emailFieldId: String(key) });
                }}
              >
                {fieldItems(emailFields)}
              </Select>
            </div>
            {askable.length ? (
              <ul
                className="rio-booking-pages__questions"
                aria-label={t({ id: 'bookings.form.more', message: 'More questions' })}
              >
                {askable.map((field) => {
                  const on = asked.has(field.id);
                  return (
                    <li key={field.id}>
                      <Checkbox
                        isSelected={on}
                        isDisabled={pending || (!on && settings.questions.length >= BOOKING_LIMITS.questions)}
                        onChange={(checked) =>
                          change({
                            questions: checked
                              ? [...settings.questions, { fieldId: field.id, required: false }]
                              : settings.questions.filter((question) => question.fieldId !== field.id),
                          })
                        }
                      >
                        {t({ id: 'bookings.form.ask', message: `Ask for ${field.name}` })}
                      </Checkbox>
                      {on ? (
                        <Checkbox
                          isSelected={asked.get(field.id) ?? false}
                          isDisabled={pending}
                          onChange={(required) =>
                            change({
                              questions: settings.questions.map((question) =>
                                question.fieldId === field.id ? { ...question, required } : question,
                              ),
                            })
                          }
                        >
                          {t({ id: 'bookings.form.required', message: `Require ${field.name}` })}
                        </Checkbox>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </fieldset>

          <fieldset className="rio-booking-pages__group">
            <legend>{t({ id: 'bookings.form.after', message: 'After booking' })}</legend>
            <TextArea
              label={t({ id: 'bookings.form.confirmation', message: 'Confirmation note' })}
              description={t({
                id: 'bookings.form.confirmation.description',
                message: 'Shown after booking and in the confirmation email, such as where to go.',
              })}
              value={settings.confirmation}
              onChange={(confirmation) => change({ confirmation })}
              maxLength={2_000}
              isDisabled={pending}
            />
            <NumberField
              label={t({ id: 'bookings.form.daily', message: 'Bookings per email address a day' })}
              value={settings.dailyPerEmail}
              minValue={1}
              maxValue={BOOKING_LIMITS.maxDailyPerEmail}
              isDisabled={pending}
              onChange={(value) => {
                if (Number.isFinite(value)) change({ dailyPerEmail: value });
              }}
            />
          </fieldset>
          <ErrorBanner error={errorInfo(save.error)} />
        </div>
        {page ? (
          <PaymentPageSettings kind="booking" targetId={page.pageId} fields={fields} />
        ) : (
          <p>
            {t({
              id: 'payments.booking.saveFirst',
              message: 'Save this page, then edit it to set up payment.',
            })}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button onPress={onCancel} isDisabled={pending}>
          {t({ id: 'bookings.form.cancel', message: 'Cancel' })}
        </Button>
        <Button type="submit" variant="primary" isPending={pending} isDisabled={missingFields}>
          {page
            ? t({ id: 'bookings.form.save', message: 'Save' })
            : t({ id: 'bookings.form.create', message: 'Make booking page' })}
        </Button>
      </DialogFooter>
    </Form>
  );
}
