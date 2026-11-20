import { faPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  DUPLICATE_LIMITS,
  duplicateMatches,
  mergeableField,
  mergedValue,
  roleAllows,
  type DuplicateGroup,
  type DuplicateMatch,
  type DuplicateRecord,
  type Duplicates,
  type DuplicatesRequest,
  type FieldMeta,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  ListBoxItem,
  Modal,
  ProgressBar,
  Select,
  Spinner,
  useConfirm,
} from '@riosoma/ui';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../../api';
import { useSaveState, useSchema } from '../../../data/hooks';
import type { DatabaseSession } from '../../../data/types';
import { formatCell, type FormatContext } from '../../../grid/format';
import { reportError, undoToast } from '../../../grid/view/actions';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useTrashPhrase } from '../../../features/retention/window';
import { GroupReview } from './GroupReview';
import { anchor } from '../../../demos/anchors';
import {
  comparableFields,
  criterion,
  defaultMatch,
  defaultPlan,
  groupKey,
  keptFirst,
  mergeCommand,
  stayInDialog,
  type Criterion,
  type MergePlan,
} from './plan';
import './dedupe.css';

type Status = 'merging' | 'merged' | 'failed';
type State = Status | 'open' | 'skipped';
interface Tally {
  sets: number;
  records: number;
  failed: number;
}
const NO_FIELDS: readonly FieldMeta[] = [];

/** A compared value as the grid shows it.  Sets carry no authors, which no compared field needs. */
const valueOf = (record: DuplicateRecord, field: FieldMeta) =>
  cellValue({ ...record, createdBy: null, updatedBy: null }, field);

export interface DuplicatesPanelProps {
  session: DatabaseSession;
  tableId: string;
  onClose(): void;
}

/**
 * Finding and merging duplicates in one table.  People choose up to three fields and how to match
 * them, see each set of records side by side, and merge one set at a time or all of them with the
 * defaults.  Every merge is an ordinary command, so it shows in the table at once, survives a
 * dropped connection, and undoes like any other change.
 */
export function DuplicatesPanel({ session, tableId, onClose }: DuplicatesPanelProps) {
  const { t, i18n } = useLingui();
  const trash = useTrashPhrase();
  const message = useServerMessage();
  const confirm = useConfirm();
  const schema = useSchema(session);
  const save = useSaveState(session);
  const table = schema?.tableById.get(tableId);
  const fields = schema?.fields.get(tableId) ?? NO_FIELDS;
  const comparable = useMemo(() => (table ? comparableFields(table, fields) : []), [table, fields]);
  const [chosen, setCriteria] = useState<Criterion[] | null>(null);
  // Until someone changes them, compare the primary field, or the first field that can be compared.
  const first = comparable[0];
  const criteria = chosen ?? (first ? [{ key: 'first', fieldId: first.id, match: defaultMatch(first) }] : []);
  const foundId = useId();
  const [request, setRequest] = useState<DuplicatesRequest | null>(null);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [statuses, setStatuses] = useState<ReadonlyMap<string, Status>>(new Map());
  const [plans, setPlans] = useState<ReadonlyMap<string, MergePlan>>(new Map());
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ total: number; before: number } | null>(null);
  const [tally, setTally] = useState<Tally | null>(null);
  // Names of linked records and file details arrive after the records do.
  const [, setRevision] = useState(0);
  useEffect(
    () => session.subscribeRecords(tableId, () => setRevision((value) => value + 1)),
    [session, tableId],
  );
  const find = useMutation({
    mutationFn: (input: DuplicatesRequest) =>
      api<Duplicates>(`/api/tables/${tableId}/duplicates`, { method: 'POST', body: input }),
    onSuccess: (found) => {
      session.rememberLinked(found.linked);
      setStatuses(new Map());
      setReviewing(null);
    },
  });
  // A table that goes away takes the panel with it.
  const gone = Boolean(schema) && !table;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (!schema || !table) return null;

  const locale = i18n.locale || 'en-US';
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  const format: FormatContext = {
    locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    collaborators: schema.collaborators,
    linked: session.linked,
    attachments: session.attachments,
    fieldsById: schema.fieldById,
  };
  const synced = Boolean(table.source || table.joined);
  const canMerge = roleAllows(schema.database.role, 'editRecords') && !synced;
  const tableName = table.name;
  const found = find.data;
  const groups = found?.groups ?? [];
  const stateOf = (group: DuplicateGroup): State => {
    const key = groupKey(group);
    return statuses.get(key) ?? (skipped.has(key) ? 'skipped' : 'open');
  };
  const waiting = groups.filter((group) => stateOf(group) === 'open' || stateOf(group) === 'failed');
  const busy = progress !== null;
  const primary = fields.find((field) => field.id === table.primaryFieldId);
  const shown = (found?.fields ?? [])
    .map(({ fieldId }) => schema.fieldById.get(fieldId))
    .filter((field): field is FieldMeta => Boolean(field));
  const columns = primary && !shown.includes(primary) ? [primary, ...shown] : shown;
  const text = (field: FieldMeta, record: DuplicateRecord) => {
    const value = formatCell(field, valueOf(record, field), format);
    return value.trim() ? value : t({ id: 'dedupe.empty', message: 'Empty' });
  };
  const nameOf = (record: DuplicateRecord) => {
    const name = primary ? formatCell(primary, valueOf(record, primary), format).trim() : '';
    return name || t({ id: 'dedupe.untitled', message: 'Untitled record' });
  };
  /** The kept record's name once merged, which may come from another record of the set. */
  const resultName = (group: DuplicateGroup, plan: MergePlan) => {
    const records = keptFirst(group.records, plan.keepId);
    const kept = records[0]!;
    if (!primary || !mergeableField(primary)) return nameOf(kept);
    const values = { ...kept.values, [primary.id]: mergedValue(primary, records, plan.choices[primary.id]) };
    return nameOf({ ...kept, values });
  };
  const add = (change: Partial<Tally>) =>
    setTally((current) => ({
      sets: (current?.sets ?? 0) + (change.sets ?? 0),
      records: (current?.records ?? 0) + (change.records ?? 0),
      failed: (current?.failed ?? 0) + (change.failed ?? 0),
    }));
  const mark = (targets: readonly DuplicateGroup[], status: Status) =>
    setStatuses((current) => {
      const next = new Map(current);
      for (const group of targets) next.set(groupKey(group), status);
      return next;
    });

  function search(event?: FormEvent) {
    event?.preventDefault();
    const input: DuplicatesRequest = { fields: criteria.map(({ fieldId, match }) => ({ fieldId, match })) };
    setRequest(input);
    setTally(null);
    setPlans(new Map());
    find.mutate(input);
  }

  function mergeOne(group: DuplicateGroup) {
    const key = groupKey(group);
    const plan = plans.get(key) ?? defaultPlan(group);
    let done: Promise<{ applied: number; rejected: number }>;
    try {
      done = session.run([mergeCommand(tableId, group, plan)]).done;
    } catch (error) {
      reportError(error);
      return;
    }
    mark([group], 'merging');
    setReviewing((current) => (current === key ? null : current));
    const records = group.records.length - 1;
    const name = resultName(group, plan);
    void done.then(({ applied }) => {
      mark([group], applied ? 'merged' : 'failed');
      // A refusal reaches the person through the session's own message.
      if (!applied) {
        add({ failed: 1 });
        return;
      }
      add({ sets: 1, records });
      undoToast(
        session,
        t({
          id: 'dedupe.merged',
          message: plural(records, {
            one: `Merged # record into ${name}`,
            other: `Merged # records into ${name}`,
          }),
        }),
      );
    });
  }

  async function mergeAll() {
    const targets = waiting;
    const sets = targets.length;
    const records = targets.reduce((sum, group) => sum + group.records.length - 1, 0);
    if (!sets) return;
    const confirmed = await confirm({
      title: t({
        id: 'dedupe.mergeAll.title',
        message: plural(sets, { one: 'Merge # set of duplicates?', other: 'Merge # sets of duplicates?' }),
      }),
      message: t({
        id: 'dedupe.mergeAll.body',
        message: plural(records, {
          one: '# record goes to the trash, and its links and comments move to the record kept.  You can undo this.',
          other:
            '# records go to the trash, and their links and comments move to the records kept.  You can undo this.',
        }),
      }),
      confirmLabel: t({ id: 'dedupe.mergeAll.confirm', message: 'Merge them' }),
    });
    if (!confirmed) return;
    const before = session.saveState().pending;
    let done: Promise<{ applied: number; rejected: number }>;
    try {
      // One action, so one undo puts every set back.
      done = session.run(
        targets.map((group) => mergeCommand(tableId, group, plans.get(groupKey(group)))),
      ).done;
    } catch (error) {
      reportError(error);
      return;
    }
    setReviewing(null);
    setProgress({ total: sets, before });
    mark(targets, 'merging');
    const { applied, rejected } = await done;
    setProgress(null);
    if (!rejected) {
      mark(targets, 'merged');
      add({ sets, records });
      undoToast(
        session,
        t({
          id: 'dedupe.mergedAll',
          message: plural(sets, { one: 'Merged # set of duplicates', other: 'Merged # sets of duplicates' }),
        }),
      );
      return;
    }
    // Which ones were refused isn't known here, so look again: what's left is still listed.
    add({ sets: applied, failed: rejected });
    if (request) find.mutate(request);
  }

  const matchLabel = (match: DuplicateMatch) =>
    match === 'exact'
      ? t({ id: 'dedupe.match.exact', message: 'Exactly' })
      : match === 'loose'
        ? t({ id: 'dedupe.match.loose', message: 'Ignoring case and spacing' })
        : t({ id: 'dedupe.match.similar', message: 'Similar text' });
  const searching = t({ id: 'dedupe.searching', message: 'Looking for duplicates…' });
  const finished = progress
    ? Math.min(progress.total, Math.max(0, progress.total - (save.pending - progress.before)))
    : 0;
  const total = progress?.total ?? 0;
  const notes = found ? notesFor(found) : [];

  function notesFor(result: Duplicates): string[] {
    const list: string[] = [];
    const compared = count(result.compared);
    const everything = count(result.total);
    if (result.fields.some((item) => item.method === 'trigram'))
      list.push(
        t({ id: 'dedupe.method.trigram', message: 'Similar text was compared by trigram similarity.' }),
      );
    if (result.fields.some((item) => item.method === 'normalized'))
      list.push(
        t({
          id: 'dedupe.method.normalized',
          message:
            'Similar text was compared ignoring case, spaces, and punctuation, since this server doesn’t have the pg_trgm extension.',
        }),
      );
    if (result.sampled)
      list.push(
        t({
          id: 'dedupe.sampled',
          message: `This table is large, so a sample of ${compared} of its ${everything} records was compared.`,
        }),
      );
    const shownCount = result.groups.length;
    if (result.truncated)
      list.push(t({ id: 'dedupe.truncated', message: `Showing the largest ${shownCount} sets.` }));
    if (result.oversized)
      list.push(
        t({
          id: 'dedupe.oversized',
          message: plural(result.oversized, {
            one: '# set was too large to be duplicates and was left out.  Compare more fields to narrow it down.',
            other:
              '# sets were too large to be duplicates and were left out.  Compare more fields to narrow them down.',
          }),
        }),
      );
    return list;
  }

  const summary = tally
    ? [
        tally.sets
          ? t({
              id: 'dedupe.summary.sets',
              message: plural(tally.sets, {
                one: 'Merged # set of duplicates.',
                other: 'Merged # sets of duplicates.',
              }),
            })
          : '',
        tally.records
          ? t({
              id: 'dedupe.summary.records',
              message: plural(tally.records, {
                one: `# record went to the trash, where it stays ${trash}.`,
                other: `# records went to the trash, where they stay ${trash}.`,
              }),
            })
          : '',
        tally.failed
          ? t({
              id: 'dedupe.summary.failed',
              message: plural(tally.failed, {
                one: '# set couldn’t be merged, so it’s still listed.',
                other: '# sets couldn’t be merged, so they’re still listed.',
              }),
            })
          : '',
      ]
        .filter(Boolean)
        .join('  ')
    : '';

  return (
    <Modal
      isOpen
      isDismissable
      size="lg"
      className="rio-dedupe"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{t({ id: 'dedupe.title', message: `Find duplicates in ${tableName}` })}</DialogTitle>
        <DialogBody>
          <p className="rio-dedupe-note">
            {t({
              id: 'dedupe.intro',
              message:
                'Records that match on the fields you choose.  Merging keeps one record, moves the others’ links and comments to it, and puts them in the trash.',
            })}
          </p>
          {comparable.length === 0 ? (
            <p>{t({ id: 'dedupe.noFields', message: 'This table has no fields that can be compared.' })}</p>
          ) : (
            <form className="rio-dedupe-criteria" onSubmit={search}>
              <ul className="rio-dedupe-criteria__list" {...anchor('dedupe.field')}>
                {criteria.map((item, index) => {
                  const field = schema.fieldById.get(item.fieldId);
                  const name = field?.name ?? '';
                  const matches = field ? duplicateMatches(field) : [];
                  const taken = new Set(
                    criteria.filter((other) => other !== item).map((other) => other.fieldId),
                  );
                  return (
                    <li key={item.key} className="rio-dedupe-criterion">
                      <Select
                        size="sm"
                        aria-label={t({ id: 'dedupe.compare.field', message: 'Field to compare' })}
                        selectedKey={item.fieldId}
                        onSelectionChange={(key) => {
                          const next = comparable.find((option) => option.id === key);
                          if (!next) return;
                          setCriteria(
                            criteria.map((other, at) =>
                              at === index
                                ? { ...other, fieldId: next.id, match: defaultMatch(next) }
                                : other,
                            ),
                          );
                        }}
                      >
                        {comparable
                          .filter((option) => !taken.has(option.id))
                          .map((option) => (
                            <ListBoxItem key={option.id} id={option.id} textValue={option.name}>
                              {option.name}
                            </ListBoxItem>
                          ))}
                      </Select>
                      <Select
                        size="sm"
                        aria-label={t({ id: 'dedupe.compare.match', message: `How to match ${name}` })}
                        selectedKey={item.match}
                        isDisabled={matches.length < 2}
                        onSelectionChange={(key) => {
                          const match = matches.find((option) => option === key);
                          if (!match) return;
                          setCriteria(
                            criteria.map((other, at) => (at === index ? { ...other, match } : other)),
                          );
                        }}
                      >
                        {matches.map((match) => (
                          <ListBoxItem key={match} id={match} textValue={matchLabel(match)}>
                            {matchLabel(match)}
                          </ListBoxItem>
                        ))}
                      </Select>
                      {criteria.length > 1 && (
                        <Button
                          size="sm"
                          variant="quiet"
                          icon={faXmark}
                          aria-label={t({ id: 'dedupe.compare.remove', message: `Stop comparing ${name}` })}
                          onPress={() => setCriteria(criteria.filter((other) => other !== item))}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="rio-dedupe-actions">
                {criteria.length < DUPLICATE_LIMITS.fields && comparable.length > criteria.length && (
                  <Button
                    size="sm"
                    variant="quiet"
                    icon={faPlus}
                    onPress={() => {
                      const used = new Set(criteria.map((item) => item.fieldId));
                      const next = comparable.find((option) => !used.has(option.id));
                      if (next) setCriteria([...criteria, criterion(next)]);
                    }}
                  >
                    {t({ id: 'dedupe.compare.add', message: 'Compare another field' })}
                  </Button>
                )}
                <Button
                  type="submit"
                  variant="primary"
                  isPending={find.isPending}
                  isDisabled={busy}
                  {...anchor('dedupe.search')}
                >
                  {t({ id: 'dedupe.search', message: 'Find duplicates' })}
                </Button>
              </div>
            </form>
          )}
          {synced ? (
            <Banner tone="info">
              {t({
                id: 'dedupe.synced',
                message:
                  'Records in this table come from its source, so duplicates can’t be merged here.  Fix them in the source.',
              })}
            </Banner>
          ) : !canMerge ? (
            <Banner tone="info">
              {t({
                id: 'dedupe.readOnly',
                message: 'You can find duplicates here.  Merging them needs permission to edit records.',
              })}
            </Banner>
          ) : null}
          {find.isPending && (
            <div className="rio-dedupe-waiting">
              <Spinner size="sm" label={searching} />
              <span aria-hidden="true">{searching}</span>
            </div>
          )}
          {find.error && (
            <Banner tone="danger">
              {message(find.error instanceof ApiError ? find.error.info.messageKey : 'errors.internal')}
            </Banner>
          )}
          {progress && (
            <ProgressBar
              className="rio-dedupe-progress"
              label={t({ id: 'dedupe.progress', message: 'Merging sets' })}
              value={finished}
              maxValue={total}
              // Sets are sent in batches, so the count moves once each batch is answered.
              isIndeterminate={finished === 0}
              valueLabel={
                finished === 0
                  ? undefined
                  : t({ id: 'dedupe.progress.value', message: `${finished} of ${total}` })
              }
            />
          )}
          {summary && <Banner tone={tally?.failed ? 'warning' : 'success'}>{summary}</Banner>}
          {found && !find.isPending && (
            <section className="rio-dedupe-results" aria-labelledby={foundId}>
              <p id={foundId} className="rio-dedupe-found">
                {groups.length
                  ? t({
                      id: 'dedupe.found',
                      message: plural(groups.length, {
                        one: `# set of duplicates among ${count(found.compared)} records`,
                        other: `# sets of duplicates among ${count(found.compared)} records`,
                      }),
                    })
                  : found.timedOut
                    ? t({ id: 'dedupe.timedOut.none', message: 'The comparison ran out of time.' })
                    : t({
                        id: 'dedupe.none',
                        message: 'No duplicates.  Try other fields, or a looser way of matching.',
                      })}
              </p>
              {found.timedOut && (
                <Banner tone="warning">
                  {t({
                    id: 'dedupe.timedOut',
                    message:
                      'This took too long, so some duplicates may be missing.  Try exact matching or fewer fields.',
                  })}
                </Banner>
              )}
              {notes.map((note) => (
                <p key={note} className="rio-dedupe-note">
                  {note}
                </p>
              ))}
              <ul className="rio-dedupe-groups">
                {groups.map((group) => {
                  const key = groupKey(group);
                  const state = stateOf(group);
                  const size = group.records.length;
                  const name = nameOf(group.records[0]!);
                  const plan = plans.get(key) ?? defaultPlan(group);
                  return (
                    <li key={key} className="rio-dedupe-group" data-state={state}>
                      <div className="rio-dedupe-group__header">
                        <h3 className="rio-dedupe-group__name">{name}</h3>
                        <span className="rio-dedupe-group__count">
                          {t({
                            id: 'dedupe.group.size',
                            message: plural(size, { one: '# record', other: '# records' }),
                          })}
                        </span>
                        {state !== 'open' && (
                          <span className="rio-dedupe-group__state">
                            {state === 'merging'
                              ? t({ id: 'dedupe.state.merging', message: 'Merging…' })
                              : state === 'merged'
                                ? t({ id: 'dedupe.state.merged', message: 'Merged' })
                                : state === 'skipped'
                                  ? t({ id: 'dedupe.state.skipped', message: 'Skipped' })
                                  : t({ id: 'dedupe.state.failed', message: 'Couldn’t merge' })}
                          </span>
                        )}
                      </div>
                      {reviewing === key ? (
                        <GroupReview
                          session={session}
                          tableId={tableId}
                          group={group}
                          fields={fields}
                          format={format}
                          plan={plan}
                          canMerge={canMerge && !busy}
                          onPlan={(next) => setPlans((current) => new Map(current).set(key, next))}
                          onMerge={() => mergeOne(group)}
                          onClose={() => setReviewing(null)}
                        />
                      ) : state === 'merged' || state === 'merging' ? null : (
                        <>
                          <div className="rio-dedupe-table">
                            <table className="rio-dedupe-values">
                              <thead>
                                <tr>
                                  <td />
                                  {group.records.map((record, index) => {
                                    const number = index + 1;
                                    return (
                                      <th key={record.id} scope="col">
                                        {t({ id: 'dedupe.record', message: `Record ${number}` })}
                                      </th>
                                    );
                                  })}
                                </tr>
                              </thead>
                              <tbody>
                                {columns.map((field) => (
                                  <tr key={field.id}>
                                    <th scope="row">{field.name}</th>
                                    {group.records.map((record) => (
                                      <td key={record.id}>{text(field, record)}</td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div className="rio-dedupe-actions">
                            {state === 'skipped' ? (
                              <Button
                                size="sm"
                                onPress={(event) => {
                                  stayInDialog(event);
                                  setSkipped((current) => {
                                    const next = new Set(current);
                                    next.delete(key);
                                    return next;
                                  });
                                }}
                              >
                                {t({ id: 'dedupe.unskip', message: 'Include it again' })}
                              </Button>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  onPress={(event) => {
                                    stayInDialog(event);
                                    setReviewing(key);
                                  }}
                                >
                                  {t({ id: 'dedupe.review', message: 'Review' })}
                                </Button>
                                {canMerge && (
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    isDisabled={busy}
                                    onPress={(event) => {
                                      stayInDialog(event);
                                      mergeOne(group);
                                    }}
                                  >
                                    {t({ id: 'dedupe.merge', message: 'Merge' })}
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="quiet"
                                  onPress={(event) => {
                                    stayInDialog(event);
                                    setSkipped((current) => new Set(current).add(key));
                                  }}
                                >
                                  {t({ id: 'dedupe.skip', message: 'Skip' })}
                                </Button>
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </DialogBody>
        <DialogFooter>
          {canMerge && waiting.length > 0 && (
            <Button variant="primary" isDisabled={busy} onPress={() => void mergeAll()}>
              {t({
                id: 'dedupe.mergeAll',
                message: plural(waiting.length, { one: 'Merge # set', other: 'Merge all # sets' }),
              })}
            </Button>
          )}
          <Button onPress={onClose}>{t({ id: 'dedupe.done', message: 'Done' })}</Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
