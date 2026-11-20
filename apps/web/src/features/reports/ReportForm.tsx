import { faXmark, faPlus } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  LIMITS,
  REPORT_RECIPIENT_LIMIT,
  type ReportFormat,
  type ReportFrequency,
  type ReportMember,
  type ReportRecipient,
  type ReportSchedule,
  type ReportScheduleInput,
} from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  ComboBox,
  DialogBody,
  DialogFooter,
  Form,
  ListBoxItem,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TextField,
  Tooltip,
  TooltipTrigger,
} from '@riosoma/ui';
import { useSession } from '../../session';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { createReport, updateReport } from './api';
import { timeLabel, useReportWords, weekdayLabel } from './words';
import { anchor } from '../../demos/anchors';

/** An address someone typed, checked loosely: the server has the final say. */
const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

const FORMATS: readonly ReportFormat[] = ['xlsx', 'csv', 'docx', 'pptx', 'pdf', 'none'];
const KINDS: ReadonlyArray<ReportFrequency['kind']> = ['daily', 'weekly', 'monthly'];

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Half-hour slots, plus the saved time when it's between them. */
function timeSlots(current: string): string[] {
  const slots = Array.from({ length: 48 }, (_, index) =>
    [Math.floor(index / 2), index % 2 ? 30 : 0].map((part) => String(part).padStart(2, '0')).join(':'),
  );
  if (!slots.includes(current)) slots.push(current);
  return slots.sort();
}

/** The frequency with its kind changed, keeping the time of day. */
function withKind(frequency: ReportFrequency, kind: ReportFrequency['kind']): ReportFrequency {
  if (kind === 'daily') return { kind, at: frequency.at };
  if (kind === 'weekly')
    return { kind, days: frequency.kind === 'weekly' ? frequency.days : [1], at: frequency.at };
  return { kind, day: frequency.kind === 'monthly' ? frequency.day : 1, at: frequency.at };
}

export interface ReportFormProps {
  viewId: string;
  viewName: string;
  /** The schedule to change, or none for a new one */
  report?: ReportSchedule;
  /** People who can open the database, when this person may add them */
  members: readonly ReportMember[];
  canAddMembers: boolean;
  outsideAllowed: boolean;
  onCancel(): void;
  onSaved(report: ReportSchedule): void;
}

/** A report's name, file, schedule, and recipients, for setting one up or changing it. */
export function ReportForm({
  viewId,
  viewName,
  report,
  members,
  canAddMembers,
  outsideAllowed,
  onCancel,
  onSaved,
}: ReportFormProps) {
  const { t } = useLingui();
  const words = useReportWords();
  const session = useSession();
  const me = session?.user;
  const fields = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(report?.name ?? viewName);
  const [format, setFormat] = useState<ReportFormat>(report?.format ?? 'xlsx');
  const [frequency, setFrequency] = useState<ReportFrequency>(
    report?.frequency ?? { kind: 'weekly', days: [1], at: '09:00' },
  );
  const [timeZone, setTimeZone] = useState(report?.timeZone ?? localTimeZone());
  const [enabled, setEnabled] = useState(report?.enabled ?? true);
  const [recipients, setRecipients] = useState<ReportRecipient[]>(
    report
      ? report.recipients.map((recipient) =>
          recipient.kind === 'member'
            ? { kind: 'member', userId: recipient.userId }
            : { kind: 'address', address: recipient.address },
        )
      : me
        ? [{ kind: 'member', userId: me.id }]
        : [],
  );
  const [search, setSearch] = useState('');
  // The member just picked, until the suggestions close.  The picker closes them when its choice
  // changes, so holding the pick as its choice closes them after a pick, as other people pickers do.
  const [picked, setPicked] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [addressProblem, setAddressProblem] = useState(false);
  const [zones] = useState(() => Intl.supportedValuesOf('timeZone'));
  // Complaints wait for the first submit, so the form doesn't open already red.
  const [attempted, setAttempted] = useState(false);
  const save = useMutation({
    mutationFn: (body: ReportScheduleInput) =>
      report ? updateReport(report.id, body) : createReport(viewId, body),
    onSuccess: onSaved,
  });
  const pending = save.isPending;

  useEffect(() => {
    const frame = requestAnimationFrame(() => fields.current?.querySelector('input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  // Names for everyone listed: the people offered, the report's own list, and the person here.
  const names = new Map<string, string>(members.map((member) => [member.id, member.name || member.email]));
  for (const recipient of report?.recipients ?? [])
    if (recipient.kind === 'member' && !names.has(recipient.userId))
      names.set(recipient.userId, recipient.name);
  if (me && !names.has(me.id)) names.set(me.id, me.name || me.email);
  const chosen = new Set(
    recipients.flatMap((recipient) => (recipient.kind === 'member' ? [recipient.userId] : [])),
  );
  const needle = search.trim().toLocaleLowerCase();
  const candidates = members.filter(
    (member) =>
      !chosen.has(member.id) && `${member.name} ${member.email}`.toLocaleLowerCase().includes(needle),
  );
  const full = recipients.length >= REPORT_RECIPIENT_LIMIT;
  const noName = name.trim() === '';
  const noRecipients = recipients.length === 0;
  const noDays = frequency.kind === 'weekly' && frequency.days.length === 0;

  function addAddress() {
    const value = address.trim().toLowerCase();
    if (!ADDRESS.test(value)) {
      setAddressProblem(true);
      return;
    }
    setAddressProblem(false);
    setAddress('');
    if (!recipients.some((recipient) => recipient.kind === 'address' && recipient.address === value))
      setRecipients([...recipients, { kind: 'address', address: value }]);
  }

  function submit() {
    setAttempted(true);
    if (noName || noRecipients || noDays || pending) return;
    save.mutate({ name: name.trim(), format, frequency, timeZone, enabled, recipients });
  }

  const recipientLabel = (recipient: ReportRecipient) =>
    recipient.kind === 'member' ? (names.get(recipient.userId) ?? recipient.userId) : recipient.address;
  const days = Array.from({ length: 31 }, (_, index) => index + 1);

  return (
    <Form
      className="rio-report-schedules__form"
      validationBehavior="aria"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogBody>
        <div className="rio-report-schedules__fields" ref={fields}>
          <TextField
            label={t({ id: 'reports.form.name', message: 'Name' })}
            {...anchor('reports.form.name')}
            description={t({
              id: 'reports.form.name.description',
              message: 'It starts the email’s subject, before the view’s name.',
            })}
            value={name}
            onChange={setName}
            maxLength={LIMITS.nameLength}
            isRequired
            isDisabled={pending}
            isInvalid={attempted && noName}
            errorMessage={t({ id: 'reports.form.name.missing', message: 'Give the report a name.' })}
          />
          <RadioGroup
            label={t({ id: 'reports.form.format', message: 'File' })}
            {...anchor('reports.form.format')}
            value={format}
            onChange={(value) => {
              const next = FORMATS.find((item) => item === value);
              if (next) setFormat(next);
            }}
            isDisabled={pending}
          >
            {FORMATS.map((item) => (
              <Radio key={item} value={item}>
                {words.formats[item]}
              </Radio>
            ))}
          </RadioGroup>
          <fieldset className="rio-report-schedules__when">
            <legend>
              <Trans id="reports.form.when">When it goes</Trans>
            </legend>
            <Select
              label={t({ id: 'reports.form.frequency', message: 'How often' })}
              {...anchor('reports.form.frequency')}
              selectedKey={frequency.kind}
              isDisabled={pending}
              onSelectionChange={(key) => {
                const kind = KINDS.find((item) => item === key);
                if (kind) setFrequency(withKind(frequency, kind));
              }}
            >
              <ListBoxItem id="daily">{t({ id: 'reports.form.daily', message: 'Every day' })}</ListBoxItem>
              <ListBoxItem id="weekly">{t({ id: 'reports.form.weekly', message: 'Every week' })}</ListBoxItem>
              <ListBoxItem id="monthly">
                {t({ id: 'reports.form.monthly', message: 'Every month' })}
              </ListBoxItem>
            </Select>
            {frequency.kind === 'weekly' ? (
              <CheckboxGroup
                label={t({ id: 'reports.form.days', message: 'On' })}
                orientation="horizontal"
                value={frequency.days.map(String)}
                isDisabled={pending}
                validationBehavior="aria"
                isInvalid={attempted && noDays}
                errorMessage={t({ id: 'reports.form.days.missing', message: 'Choose at least one day.' })}
                onChange={(values) =>
                  setFrequency({
                    ...frequency,
                    days: values
                      .map(Number)
                      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
                      .sort((a, b) => a - b),
                  })
                }
              >
                {Array.from({ length: 7 }, (_, day) => (
                  <Checkbox key={day} value={String(day)}>
                    {weekdayLabel(day, words.locale, 'short')}
                  </Checkbox>
                ))}
              </CheckboxGroup>
            ) : null}
            {frequency.kind === 'monthly' ? (
              <Select
                label={t({ id: 'reports.form.day', message: 'Day of the month' })}
                description={t({
                  id: 'reports.form.day.description',
                  message: 'In a shorter month, it goes on the last day.',
                })}
                selectedKey={String(frequency.day)}
                isDisabled={pending}
                onSelectionChange={(key) => {
                  const day = Number(key);
                  if (Number.isInteger(day) && day >= 1 && day <= 31) setFrequency({ ...frequency, day });
                }}
              >
                {days.map((day) => (
                  <ListBoxItem key={day} id={String(day)}>
                    {String(day)}
                  </ListBoxItem>
                ))}
              </Select>
            ) : null}
            <Select
              label={t({ id: 'reports.form.at', message: 'At' })}
              selectedKey={frequency.at}
              isDisabled={pending}
              onSelectionChange={(key) => {
                if (key !== null) setFrequency({ ...frequency, at: String(key) });
              }}
            >
              {timeSlots(frequency.at).map((at) => (
                <ListBoxItem key={at} id={at}>
                  {timeLabel(at, words.locale)}
                </ListBoxItem>
              ))}
            </Select>
            <ComboBox
              label={t({ id: 'reports.form.timeZone', message: 'Time zone' })}
              selectedKey={timeZone}
              isDisabled={pending}
              onSelectionChange={(key) => {
                if (key !== null) setTimeZone(String(key));
              }}
            >
              {(zones.includes(timeZone) ? zones : [timeZone, ...zones]).map((zone) => (
                <ListBoxItem key={zone} id={zone} textValue={zone}>
                  {zone}
                </ListBoxItem>
              ))}
            </ComboBox>
          </fieldset>
          <fieldset className="rio-report-schedules__who">
            <legend>
              <Trans id="reports.form.recipients">Send to</Trans>
            </legend>
            {canAddMembers ? null : (
              <p className="rio-report-schedules__note">
                <Trans id="reports.form.onlyYou">
                  {'It goes to you.  People who can change this view can send it to others.'}
                </Trans>
              </p>
            )}
            <ul className="rio-report-schedules__recipients">
              {recipients.map((recipient) => {
                const label = recipientLabel(recipient);
                const remove = t({ id: 'reports.form.remove', message: `Remove ${label}` });
                const key = recipient.kind === 'member' ? recipient.userId : recipient.address;
                return (
                  <li key={key} className="rio-report-schedules__recipient">
                    <span>{label}</span>
                    {recipient.kind === 'address' ? (
                      <span className="rio-report-schedules__outside">
                        <Trans id="reports.form.outside">Outside the organization</Trans>
                      </span>
                    ) : null}
                    <TooltipTrigger>
                      <Button
                        variant="quiet"
                        size="sm"
                        icon={faXmark}
                        aria-label={remove}
                        isDisabled={pending}
                        onPress={() => setRecipients(recipients.filter((item) => item !== recipient))}
                      />
                      <Tooltip>{remove}</Tooltip>
                    </TooltipTrigger>
                  </li>
                );
              })}
            </ul>
            {attempted && noRecipients ? (
              <p className="rio-report-schedules__problem" role="alert">
                <Trans id="reports.form.recipients.missing">Add at least one person to send it to.</Trans>
              </p>
            ) : null}
            {canAddMembers ? (
              <ComboBox
                label={t({ id: 'reports.form.addMember', message: 'Add a member of this database' })}
                inputValue={search}
                onInputChange={setSearch}
                selectedKey={picked}
                isDisabled={pending || full}
                onOpenChange={(open) => {
                  if (!open) setPicked(null);
                }}
                onSelectionChange={(key) => {
                  const member = candidates.find((item) => item.id === key);
                  if (!member) return;
                  setPicked(member.id);
                  setSearch('');
                  setRecipients([...recipients, { kind: 'member', userId: member.id }]);
                }}
              >
                {candidates.map((member) => (
                  <ListBoxItem
                    key={member.id}
                    id={member.id}
                    textValue={`${member.name} ${member.email}`}
                    description={member.email}
                  >
                    {member.name || member.email}
                  </ListBoxItem>
                ))}
              </ComboBox>
            ) : me && !chosen.has(me.id) ? (
              <div>
                <Button
                  size="sm"
                  isDisabled={pending}
                  onPress={() => setRecipients([...recipients, { kind: 'member', userId: me.id }])}
                >
                  <Trans id="reports.form.addMe">Send it to me</Trans>
                </Button>
              </div>
            ) : null}
            {outsideAllowed ? (
              <div className="rio-report-schedules__address">
                <TextField
                  label={t({
                    id: 'reports.form.address',
                    message: 'Add an address outside the organization',
                  })}
                  description={t({
                    id: 'reports.form.address.description',
                    message: 'It gets the records and fields you can see.',
                  })}
                  type="email"
                  value={address}
                  onChange={(value) => {
                    setAddress(value);
                    setAddressProblem(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addAddress();
                    }
                  }}
                  isDisabled={pending || full}
                  isInvalid={addressProblem}
                  errorMessage={t({
                    id: 'reports.form.address.invalid',
                    message: 'Enter an email address, like name@example.com.',
                  })}
                />
                <Button
                  size="sm"
                  isDisabled={pending || full || address.trim() === ''}
                  onPress={addAddress}
                  aria-label={t({ id: 'reports.form.address.add', message: 'Add address' })}
                  icon={faPlus}
                />
              </div>
            ) : null}
          </fieldset>
          <Switch isSelected={enabled} onChange={setEnabled} isDisabled={pending}>
            {t({ id: 'reports.form.enabled', message: 'Send on this schedule' })}
          </Switch>
          <ErrorBanner error={errorInfo(save.error)} />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onPress={onCancel} isDisabled={pending}>
          <Trans id="reports.cancel">Cancel</Trans>
        </Button>
        <Button type="submit" variant="primary" isPending={pending} {...anchor('reports.form.save')}>
          {report ? <Trans id="reports.save">Save</Trans> : <Trans id="reports.create">Set up report</Trans>}
        </Button>
      </DialogFooter>
    </Form>
  );
}
