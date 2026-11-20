import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ROUTINE_DEFAULT_CAP_USD,
  ROUTINE_LIMITS,
  type DatabaseSummary,
  type Routine,
  type RoutineDraft,
  type RoutinePlan,
  type RoutineSchedule,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  CheckboxGroup,
  ComboBox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Form,
  ListBoxItem,
  Modal,
  Select,
  Spinner,
  TextArea,
  TextField,
} from '@riosoma/ui';
import { api } from '../../api';
import { useSession } from '../../session';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { timeLabel, weekdayLabel } from '../reports/words';
import { FootprintLine } from '../ai-footprint/FootprintLine';
import { rioStatusQuery } from '../rio/status';
import { createRoutine, draftRoutine, refreshRoutines, routineSites, updateRoutine } from './api';
import { useRoutineWords } from './words';
import './routines.css';

const KINDS: ReadonlyArray<RoutineSchedule['kind']> = ['hourly', 'daily', 'weekly', 'monthly'];

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

/** The schedule with its kind changed, keeping what carries over. */
function withKind(schedule: RoutineSchedule, kind: RoutineSchedule['kind']): RoutineSchedule {
  const at = schedule.kind === 'hourly' ? '09:00' : schedule.at;
  if (kind === 'hourly') return { kind };
  if (kind === 'daily') return { kind, at };
  if (kind === 'weekly') return { kind, days: schedule.kind === 'weekly' ? schedule.days : [1], at };
  return { kind, day: schedule.kind === 'monthly' ? schedule.day : 1, at };
}

/** A send's recipients as the exact list the server matches, with the owner as their address. */
function listOf(to: readonly string[], ownerEmail: string): string[] {
  return [...new Set(to.map((entry) => (entry === 'owner' ? ownerEmail : entry).toLowerCase()))].sort();
}
const keyOf = (list: readonly string[]) => list.join(',');

export interface RoutineDialogProps {
  /** The database it belongs to, or none to choose one */
  databaseId?: string;
  /** The routine to change, or none for a new one */
  routine?: Routine;
  onClose(): void;
  onSaved?(routine: Routine): void;
}

/** Setting up a routine, or changing one, in a dialog of its own. */
export function RoutineDialog({ databaseId, routine, onClose, onSaved }: RoutineDialogProps) {
  const { t } = useLingui();
  return (
    <Modal
      isOpen
      isDismissable
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          {routine
            ? t({ id: 'routines.edit.title', message: 'Change routine' })
            : t({ id: 'routines.new.title', message: 'New routine' })}
        </DialogTitle>
        <RoutineForm
          {...(databaseId ? { databaseId } : {})}
          {...(routine ? { routine } : {})}
          onCancel={onClose}
          onSaved={(saved) => {
            onSaved?.(saved);
            onClose();
          }}
        />
      </Dialog>
    </Modal>
  );
}

export interface RoutineFormProps {
  databaseId?: string;
  routine?: Routine;
  onCancel(): void;
  onSaved(routine: Routine): void;
}

/**
 * What a routine does, in the person's own words, and when.  Rio restates the words as a short
 * plan, with the tables it reads and changes, what it sends to whom, and what a run is likely to
 * cost, and the person saves that.  Changing the words asks Rio to restate them again.
 */
export function RoutineForm({ databaseId: fixed, routine, onCancel, onSaved }: RoutineFormProps) {
  const { t, i18n } = useLingui();
  const words = useRoutineWords();
  const client = useQueryClient();
  const session = useSession();
  const ownerEmail = (session?.user.email ?? '').toLowerCase();
  const status = useQuery(rioStatusQuery);
  const limit = status.data?.routineRunLimitUsd ?? 1;
  const databases = useQuery({
    queryKey: ['databases'],
    queryFn: ({ signal }) => api<DatabaseSummary[]>('/api/databases', { signal }),
    enabled: !fixed && !routine,
  });
  const [databaseId, setDatabaseId] = useState(routine?.databaseId ?? fixed ?? '');
  const [name, setName] = useState(routine?.name ?? '');
  const [instructions, setInstructions] = useState(routine?.instructions ?? '');
  const [schedule, setSchedule] = useState<RoutineSchedule>(
    routine?.schedule ?? { kind: 'weekly', days: [1], at: '09:00' },
  );
  const [timeZone, setTimeZone] = useState(routine?.timeZone ?? localTimeZone());
  const [cap, setCap] = useState(String(routine?.costCapUsd ?? Math.min(ROUTINE_DEFAULT_CAP_USD, limit)));
  const [plan, setPlan] = useState<{ plan: RoutinePlan; for: string; draft?: RoutineDraft } | null>(
    routine ? { plan: routine.plan, for: routine.instructions } : null,
  );
  const [approved, setApproved] = useState<string[]>(
    (routine?.approvedRecipients ?? []).map((list) => keyOf(list)),
  );
  const [sites, setSites] = useState<string[]>(routine?.approvedSites ?? []);
  const [attempted, setAttempted] = useState(false);
  const [zones] = useState(() => Intl.supportedValuesOf('timeZone'));
  const draft = useMutation({
    mutationFn: () => draftRoutine({ databaseId, instructions: instructions.trim(), locale: i18n.locale }),
    onSuccess: (result) => {
      setPlan({ plan: result.plan, for: instructions.trim(), draft: result });
      if (!name.trim()) setName(result.name);
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      const current = plan!.plan;
      const approvedRecipients = approved.map((key) => key.split(',')).filter((list) => list[0]);
      const body = {
        name: name.trim(),
        instructions: instructions.trim(),
        plan: current,
        schedule,
        timeZone,
        locale: i18n.locale,
        costCapUsd: Number(cap),
        approvedRecipients,
        // Sites matter only to a plan that reads them.
        approvedSites: current.fetches.length ? sites : [],
      };
      return routine ? updateRoutine(routine.id, body) : createRoutine({ databaseId, ...body });
    },
    onSuccess: async (saved) => {
      await refreshRoutines(client);
      onSaved(saved);
    },
  });
  const busy = draft.isPending || save.isPending;
  const capValue = Number(cap);
  const badCap =
    cap.trim() === '' ||
    !Number.isFinite(capValue) ||
    capValue < ROUTINE_LIMITS.minCapUsd ||
    capValue > limit;
  const stale = plan !== null && plan.for !== instructions.trim();
  // The sites the plan's fields name now, for the owner to approve while saving.
  const fetches = plan && !stale ? plan.plan.fetches : [];
  const found = useQuery({
    queryKey: [
      'routines',
      'sites',
      databaseId,
      fetches.map((item) => `${item.tableId}.${item.fieldId}`).join(','),
    ],
    queryFn: ({ signal }) => routineSites({ databaseId, fetches }, signal),
    enabled: Boolean(databaseId) && fetches.length > 0,
  });
  const siteList = [...new Set([...(found.data?.sites ?? []), ...sites])].sort();
  const noDays = schedule.kind === 'weekly' && schedule.days.length === 0;
  const ready =
    Boolean(databaseId) &&
    name.trim() !== '' &&
    instructions.trim() !== '' &&
    !badCap &&
    !noDays &&
    plan &&
    !stale;
  const names = { ...(routine?.tableNames ?? {}), ...(plan?.draft?.tableNames ?? {}) };
  const fieldNames = { ...(routine?.fieldNames ?? {}), ...(plan?.draft?.fieldNames ?? {}) };
  const tableList = (ids: readonly string[]) =>
    ids.length
      ? words.list(ids.map((id) => names[id] ?? id))
      : t({ id: 'routines.plan.none', message: 'None' });
  const days = Array.from({ length: 31 }, (_, index) => index + 1);
  const limitWords = words.money(limit);
  const estimate = plan?.draft?.estimate;

  return (
    <Form
      className="rio-routines__form"
      validationBehavior="aria"
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (ready && !busy) save.mutate();
      }}
    >
      <DialogBody>
        <div className="rio-routines__fields">
          {!fixed && !routine ? (
            databases.isPending ? (
              <Spinner label={t({ id: 'routines.form.databases.loading', message: 'Loading databases' })} />
            ) : (
              <Select
                label={t({ id: 'routines.form.database', message: 'Database' })}
                selectedKey={databaseId || null}
                isDisabled={busy}
                isInvalid={attempted && !databaseId}
                errorMessage={t({ id: 'routines.form.database.missing', message: 'Choose a database.' })}
                onSelectionChange={(key) => {
                  setDatabaseId(key === null ? '' : String(key));
                  setPlan(null);
                }}
              >
                {(databases.data ?? []).map((database) => (
                  <ListBoxItem key={database.id} id={database.id} textValue={database.name}>
                    {database.name}
                  </ListBoxItem>
                ))}
              </Select>
            )
          ) : null}
          <TextArea
            label={t({ id: 'routines.form.instructions', message: 'What should Rio do?' })}
            description={t({
              id: 'routines.form.instructions.description',
              message:
                'Say it in your own words, like “Summarize last week’s new requests and email the summary to me.”',
            })}
            value={instructions}
            onChange={setInstructions}
            maxLength={ROUTINE_LIMITS.instructionsLength}
            isRequired
            isDisabled={busy}
            isInvalid={attempted && instructions.trim() === ''}
            errorMessage={t({
              id: 'routines.form.instructions.missing',
              message: 'Say what the routine does.',
            })}
          />
          <fieldset className="rio-routines__when">
            <legend>
              <Trans id="routines.form.when">When it runs</Trans>
            </legend>
            <Select
              label={t({ id: 'routines.form.frequency', message: 'How often' })}
              selectedKey={schedule.kind}
              isDisabled={busy}
              onSelectionChange={(key) => {
                const kind = KINDS.find((item) => item === key);
                if (kind) setSchedule(withKind(schedule, kind));
              }}
            >
              <ListBoxItem id="hourly">
                {t({ id: 'routines.form.hourly', message: 'Every hour' })}
              </ListBoxItem>
              <ListBoxItem id="daily">{t({ id: 'routines.form.daily', message: 'Every day' })}</ListBoxItem>
              <ListBoxItem id="weekly">
                {t({ id: 'routines.form.weekly', message: 'Every week' })}
              </ListBoxItem>
              <ListBoxItem id="monthly">
                {t({ id: 'routines.form.monthly', message: 'Every month' })}
              </ListBoxItem>
            </Select>
            {schedule.kind === 'weekly' ? (
              <CheckboxGroup
                label={t({ id: 'routines.form.days', message: 'On' })}
                orientation="horizontal"
                value={schedule.days.map(String)}
                isDisabled={busy}
                validationBehavior="aria"
                isInvalid={attempted && noDays}
                errorMessage={t({ id: 'routines.form.days.missing', message: 'Choose at least one day.' })}
                onChange={(values) =>
                  setSchedule({
                    ...schedule,
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
            {schedule.kind === 'monthly' ? (
              <Select
                label={t({ id: 'routines.form.day', message: 'Day of the month' })}
                description={t({
                  id: 'routines.form.day.description',
                  message: 'In a shorter month, it runs on the last day.',
                })}
                selectedKey={String(schedule.day)}
                isDisabled={busy}
                onSelectionChange={(key) => {
                  const day = Number(key);
                  if (Number.isInteger(day) && day >= 1 && day <= 31) setSchedule({ ...schedule, day });
                }}
              >
                {days.map((day) => (
                  <ListBoxItem key={day} id={String(day)}>
                    {String(day)}
                  </ListBoxItem>
                ))}
              </Select>
            ) : null}
            {schedule.kind !== 'hourly' ? (
              <Select
                label={t({ id: 'routines.form.at', message: 'At' })}
                selectedKey={schedule.at}
                isDisabled={busy}
                onSelectionChange={(key) => {
                  if (key !== null) setSchedule({ ...schedule, at: String(key) });
                }}
              >
                {timeSlots(schedule.at).map((at) => (
                  <ListBoxItem key={at} id={at}>
                    {timeLabel(at, words.locale)}
                  </ListBoxItem>
                ))}
              </Select>
            ) : null}
            <ComboBox
              label={t({ id: 'routines.form.timeZone', message: 'Time zone' })}
              selectedKey={timeZone}
              isDisabled={busy}
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
          <TextField
            label={t({ id: 'routines.form.cap', message: 'Most one run may spend (US dollars)' })}
            description={t({
              id: 'routines.form.cap.description',
              message: `A run stops when it reaches this.  Your organization allows up to ${limitWords}.`,
            })}
            inputMode="decimal"
            value={cap}
            onChange={setCap}
            isDisabled={busy}
            isInvalid={badCap}
            validationBehavior="aria"
            errorMessage={t({
              id: 'routines.form.cap.invalid',
              message: `Choose an amount from $0.01 to ${limitWords}.`,
            })}
          />
          <div className="rio-routines__restate">
            <Button
              isDisabled={busy || !databaseId || instructions.trim() === ''}
              isPending={draft.isPending}
              onPress={() => {
                draft.reset();
                draft.mutate();
              }}
            >
              {plan
                ? t({ id: 'routines.form.restateAgain', message: 'Ask Rio to restate it again' })
                : t({ id: 'routines.form.restate', message: 'Ask Rio to restate it' })}
            </Button>
            {stale ? (
              <p className="rio-routines__note" role="status">
                <Trans id="routines.form.stale">
                  The words changed, so ask Rio to restate them before saving.
                </Trans>
              </p>
            ) : !plan && attempted ? (
              <p className="rio-routines__note" role="status">
                <Trans id="routines.form.needsPlan">
                  Ask Rio to restate it, so you can check the plan before saving.
                </Trans>
              </p>
            ) : null}
          </div>
          <ErrorBanner error={errorInfo(draft.error)} />
          {plan && !stale ? (
            <section
              className="rio-routines__plan"
              aria-label={t({ id: 'routines.plan.title', message: 'Rio’s plan' })}
            >
              <p>
                <strong>{plan.plan.summary}</strong>
              </p>
              <ol>
                {plan.plan.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
              <dl className="rio-routines__facts">
                <div>
                  <dt>
                    <Trans id="routines.plan.reads">Reads</Trans>
                  </dt>
                  <dd>{tableList(plan.plan.reads)}</dd>
                </div>
                <div>
                  <dt>
                    <Trans id="routines.plan.writes">Changes, with your approval</Trans>
                  </dt>
                  <dd>{tableList(plan.plan.writes)}</dd>
                </div>
                {plan.plan.fetches.length ? (
                  <div>
                    <dt>
                      <Trans id="routines.plan.fetches">Reads pages from</Trans>
                    </dt>
                    <dd>
                      {words.pageSources(plan.plan, names, fieldNames)}
                      <span className="rio-routines__note">
                        {' '}
                        {t({
                          id: 'routines.plan.fetches.sites',
                          message:
                            '(only the home page of a site you approve, or an address written exactly in your words)',
                        })}
                      </span>
                    </dd>
                  </div>
                ) : null}
                {estimate ? (
                  <div>
                    <dt>
                      <Trans id="routines.plan.estimate">Each run, about</Trans>
                    </dt>
                    <dd>
                      <Estimate
                        tokens={estimate.inputTokens + estimate.outputTokens}
                        cost={estimate.costUsd}
                      />
                      <FootprintLine footprint={estimate.footprint} />
                    </dd>
                  </div>
                ) : null}
              </dl>
              {plan.plan.sends.length ? (
                <div className="rio-routines__sends">
                  <p>
                    <Trans id="routines.plan.sends">It sends:</Trans>
                  </p>
                  <ul>
                    {plan.plan.sends.map((send, index) => {
                      const list = listOf(send.to, ownerEmail);
                      const toOthers = list.some((address) => address !== ownerEmail);
                      const who = words.list(send.to.map((entry) => words.recipient(entry, ownerEmail)));
                      const what = send.what;
                      return (
                        <li key={index}>
                          {t({ id: 'routines.plan.send', message: `${what}, to ${who}` })}
                          {toOthers ? (
                            <Checkbox
                              isSelected={approved.includes(keyOf(list))}
                              isDisabled={busy}
                              onChange={(selected) =>
                                setApproved((current) =>
                                  selected
                                    ? [...new Set([...current, keyOf(list)])]
                                    : current.filter((key) => key !== keyOf(list)),
                                )
                              }
                            >
                              {t({
                                id: 'routines.plan.approveList',
                                message: 'Send to exactly these people without asking me each time',
                              })}
                            </Checkbox>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              {fetches.length ? (
                <div className="rio-routines__sends">
                  {found.isPending ? (
                    <Spinner label={t({ id: 'routines.plan.sites.loading', message: 'Finding sites' })} />
                  ) : siteList.length ? (
                    <>
                      <CheckboxGroup
                        label={t({ id: 'routines.plan.sites', message: 'Sites it may read' })}
                        description={t({
                          id: 'routines.plan.sites.help',
                          message:
                            'It reads only the home page of a site you check.  A new site it finds later waits for you in your notifications.',
                        })}
                        value={sites}
                        isDisabled={busy}
                        onChange={setSites}
                      >
                        <div className="rio-routines__sites">
                          {siteList.map((site) => (
                            <Checkbox key={site} value={site}>
                              {site}
                            </Checkbox>
                          ))}
                        </div>
                      </CheckboxGroup>
                      {siteList.length > 1 && siteList.some((site) => !sites.includes(site)) ? (
                        <Button
                          size="sm"
                          variant="quiet"
                          isDisabled={busy}
                          onPress={() => setSites(siteList)}
                        >
                          {t({ id: 'routines.plan.sites.all', message: 'Check them all' })}
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <p className="rio-routines__note">
                      {t({
                        id: 'routines.plan.sites.none',
                        message:
                          'These fields don’t name a site yet.  A site it finds later waits for you in your notifications.',
                      })}
                    </p>
                  )}
                  <ErrorBanner error={errorInfo(found.error)} />
                </div>
              ) : null}
              <p className="rio-routines__note">
                <Trans id="routines.plan.approval">
                  {
                    'It never changes anything on its own.  Every change it wants to make, email to anyone but you, and new sites wait for your approval in your notifications.  It only reads, and emails you, while you’re away.'
                  }
                </Trans>
              </p>
            </section>
          ) : null}
          {approved.some(
            (key) => !plan?.plan.sends.some((send) => keyOf(listOf(send.to, ownerEmail)) === key),
          ) ? (
            <div className="rio-routines__sends">
              <p>
                <Trans id="routines.form.alsoApproved">It also emails these without asking:</Trans>
              </p>
              <ul>
                {approved
                  .filter(
                    (key) => !plan?.plan.sends.some((send) => keyOf(listOf(send.to, ownerEmail)) === key),
                  )
                  .map((key) => {
                    const who = words.list(key.split(','));
                    return (
                      <li key={key}>
                        {who}{' '}
                        <Button
                          size="sm"
                          variant="quiet"
                          isDisabled={busy}
                          onPress={() => setApproved((current) => current.filter((item) => item !== key))}
                        >
                          {t({ id: 'routines.form.stopApproved', message: `Ask me first for ${who}` })}
                        </Button>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ) : null}
          <TextField
            label={t({ id: 'routines.form.name', message: 'Name' })}
            value={name}
            onChange={setName}
            maxLength={ROUTINE_LIMITS.nameLength}
            isRequired
            isDisabled={busy}
            isInvalid={attempted && name.trim() === ''}
            errorMessage={t({ id: 'routines.form.name.missing', message: 'Give the routine a name.' })}
          />
          {status.data && !status.data.routines ? (
            <Banner tone="info">
              {t({ id: 'routines.off.banner', message: 'Routines are turned off here right now.' })}
            </Banner>
          ) : null}
          <ErrorBanner error={errorInfo(save.error)} />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button isDisabled={save.isPending} onPress={onCancel}>
          <Trans id="routines.form.cancel">Cancel</Trans>
        </Button>
        <Button type="submit" variant="primary" isPending={save.isPending} isDisabled={draft.isPending}>
          {routine
            ? t({ id: 'routines.form.saveChanges', message: 'Save changes' })
            : t({ id: 'routines.form.save', message: 'Save routine' })}
        </Button>
      </DialogFooter>
    </Form>
  );
}

/** What a run is likely to use: its cost when the model's price is known, and its tokens. */
function Estimate({ tokens, cost }: { tokens: number; cost: number | null }) {
  const { t } = useLingui();
  const words = useRoutineWords();
  const count = words.tokens(tokens);
  if (cost === null) return <>{t({ id: 'routines.plan.estimate.tokens', message: `${count} tokens` })}</>;
  const amount = words.money(cost);
  return <>{t({ id: 'routines.plan.estimate.cost', message: `${amount} and ${count} tokens` })}</>;
}
