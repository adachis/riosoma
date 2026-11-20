import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  combinableField,
  defaultMergeChoice,
  mergeableField,
  mergedValue,
  sameInEvery,
  type CellValue,
  type DuplicateGroup,
  type FieldMeta,
  type RowData,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  Radio,
  RadioGroup,
  Spinner,
} from '@riosoma/ui';
import { useEffect, useState, type CSSProperties } from 'react';
import { ApiError } from '../../../api';
import type { DatabaseSession } from '../../../data/types';
import { formatCell, type FormatContext } from '../../../grid/format';
import { useServerMessage } from '../../../messages/useServerMessage';
import { keptFirst, stayInDialog, type MergePlan } from './plan';

type Loaded = { rows: RowData[] } | { missing: true } | { error: string } | null;

/** A set's records in full, kept current as they or the names they link to change. */
function useRecords(session: DatabaseSession, tableId: string, key: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>(null);
  useEffect(() => {
    let active = true;
    const ids = key.split(',');
    const settle = (rows: ReadonlyArray<RowData | null | undefined>) => {
      const found = rows.filter((row): row is RowData => Boolean(row));
      setLoaded(found.length === ids.length ? { rows: found } : { missing: true });
    };
    const unsubscribe = session.subscribeRecords(tableId, (changed) => {
      if (active && ids.some((id) => changed.has(id)))
        settle(ids.map((id) => session.cachedRecord(tableId, id)));
    });
    void Promise.all(ids.map((id) => session.getRecord(tableId, id)))
      .then((rows) => {
        if (active) settle(rows);
      })
      .catch((error: unknown) => {
        if (active)
          setLoaded({ error: error instanceof ApiError ? error.info.messageKey : 'errors.offline' });
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [session, tableId, key]);
  return loaded;
}

export interface GroupReviewProps {
  session: DatabaseSession;
  tableId: string;
  group: DuplicateGroup;
  fields: readonly FieldMeta[];
  format: FormatContext;
  plan: MergePlan;
  canMerge: boolean;
  onPlan(plan: MergePlan): void;
  onMerge(): void;
  onClose(): void;
}

/**
 * One set side by side: which record to keep, and for each field that differs, whose value the
 * kept record ends up with.  Lists combine unless someone picks one record's.
 */
export function GroupReview({
  session,
  tableId,
  group,
  fields,
  format,
  plan,
  canMerge,
  onPlan,
  onMerge,
  onClose,
}: GroupReviewProps) {
  const { t } = useLingui();
  const message = useServerMessage();
  const loaded = useRecords(session, tableId, group.records.map((record) => record.id).join(','));
  const loading = t({ id: 'dedupe.review.loading', message: 'Loading records…' });
  if (!loaded)
    return (
      <div className="rio-dedupe-waiting">
        <Spinner size="sm" label={loading} />
        <span aria-hidden="true">{loading}</span>
      </div>
    );
  if ('error' in loaded) return <Banner tone="danger">{message(loaded.error)}</Banner>;
  if ('missing' in loaded)
    return (
      <Banner tone="warning">
        {t({
          id: 'dedupe.review.missing',
          message:
            'One of these records was deleted.  Find duplicates again to see the sets as they are now.',
        })}
      </Banner>
    );
  const rows = loaded.rows;
  const records = keptFirst(rows, plan.keepId);
  const mergeable = fields.filter((field) => mergeableField(field));
  const differing = mergeable.filter((field) => !sameInEvery(field, rows));
  const same = mergeable.filter((field) => sameInEvery(field, rows));
  const text = (field: FieldMeta, value: CellValue) => {
    const shown = formatCell(field, value, format);
    return shown.trim() ? shown : t({ id: 'dedupe.empty', message: 'Empty' });
  };
  const dates = new Intl.DateTimeFormat(format.locale, { dateStyle: 'medium' });
  const layout = { '--rio-dedupe-records': rows.length } as CSSProperties;
  const sameCount = same.length;
  return (
    <div className="rio-dedupe-review">
      <p className="rio-dedupe-note">
        {t({
          id: 'dedupe.review.intro',
          message:
            'Choose the record to keep and the value each field keeps.  Lists combine unless you choose one.',
        })}
      </p>
      <div className="rio-dedupe-choices" style={layout}>
        <RadioGroup
          className="rio-dedupe-row rio-dedupe-row--keep"
          label={t({ id: 'dedupe.keep', message: 'Record to keep' })}
          orientation="horizontal"
          value={plan.keepId}
          isDisabled={!canMerge}
          onChange={(keepId) => onPlan({ ...plan, keepId })}
        >
          {rows.map((row, index) => {
            const number = index + 1;
            const added = dates.format(new Date(row.createdAt));
            return (
              <Radio
                key={row.id}
                value={row.id}
                // Reviewing starts here, where the Review button was.
                autoFocus={row.id === plan.keepId}
                description={t({ id: 'dedupe.added', message: `Added ${added}` })}
              >
                {t({ id: 'dedupe.record', message: `Record ${number}` })}
              </Radio>
            );
          })}
        </RadioGroup>
        {differing.map((field) => {
          const combined = combinableField(field)
            ? text(field, mergedValue(field, records, 'combine'))
            : null;
          return (
            <RadioGroup
              key={field.id}
              className="rio-dedupe-row"
              label={field.name}
              orientation="horizontal"
              value={plan.choices[field.id] ?? defaultMergeChoice(field, records)}
              isDisabled={!canMerge}
              onChange={(choice) => onPlan({ ...plan, choices: { ...plan.choices, [field.id]: choice } })}
            >
              {rows.map((row, index) => {
                const number = index + 1;
                const shown = text(field, cellValue(row, field));
                return (
                  <Radio
                    key={row.id}
                    value={row.id}
                    aria-label={t({ id: 'dedupe.value', message: `${shown}, record ${number}` })}
                  >
                    {shown}
                  </Radio>
                );
              })}
              {combined === null ? null : (
                <Radio value="combine" description={combined}>
                  {t({ id: 'dedupe.combine', message: 'Combine' })}
                </Radio>
              )}
            </RadioGroup>
          );
        })}
      </div>
      {sameCount > 0 && (
        <Disclosure className="rio-dedupe-same">
          <DisclosureTrigger level={4}>
            {t({
              id: 'dedupe.review.same',
              message: plural(sameCount, {
                one: '# field is the same in every record',
                other: '# fields are the same in every record',
              }),
            })}
          </DisclosureTrigger>
          <DisclosurePanel>
            <dl className="rio-dedupe-same__list">
              {same.map((field) => (
                <div key={field.id}>
                  <dt>{field.name}</dt>
                  <dd>{text(field, cellValue(rows[0]!, field))}</dd>
                </div>
              ))}
            </dl>
          </DisclosurePanel>
        </Disclosure>
      )}
      <div className="rio-dedupe-actions">
        {canMerge && (
          <Button
            variant="primary"
            onPress={(event) => {
              stayInDialog(event);
              onMerge();
            }}
          >
            {t({ id: 'dedupe.mergeThese', message: 'Merge these records' })}
          </Button>
        )}
        <Button
          onPress={(event) => {
            stayInDialog(event);
            onClose();
          }}
          aria-label={t({ id: 'dedupe.review.close', message: 'Close' })}
          icon={faXmark}
        />
      </div>
    </div>
  );
}
