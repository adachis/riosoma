import { msg, plural } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react/macro';
import { isCopyDone, type CopyPhase, type DatabaseCopy } from '@riosoma/contracts';
import { Banner, ProgressBar } from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { serverMessage } from '../../messages/useServerMessage';
import { watchCopy } from './api';

const PHASES: Record<CopyPhase | 'queued', MessageDescriptor> = {
  queued: msg({ id: 'archives.copy.phase.queued', message: 'Waiting to start' }),
  reading: msg({ id: 'archives.copy.phase.reading', message: 'Reading the database' }),
  tables: msg({ id: 'archives.copy.phase.tables', message: 'Making tables and fields' }),
  records: msg({ id: 'archives.copy.phase.records', message: 'Copying records and files' }),
  links: msg({ id: 'archives.copy.phase.links', message: 'Linking records' }),
  fields: msg({ id: 'archives.copy.phase.fields', message: 'Making formulas, lookups, and rollups' }),
  views: msg({ id: 'archives.copy.phase.views', message: 'Making views' }),
  finishing: msg({
    id: 'archives.copy.phase.finishing',
    message: 'Adding dashboards, automations, and comments',
  }),
};

/**
 * Follows a restore or a duplicate from start to finish.  Each answer waits on the server for the
 * copy's next step, so this asks only as often as things move.  It reports the copy each time, and
 * shows what it made, or why it couldn't, once it's done.
 */
export function CopyProgress({
  copy: first,
  onChange,
}: {
  copy: DatabaseCopy;
  onChange(copy: DatabaseCopy): void;
}) {
  const { t, i18n } = useLingui();
  const [copy, setCopy] = useState(first);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(first.version);
  const report = useRef(onChange);
  useEffect(() => {
    report.current = onChange;
  });
  const done = isCopyDone(copy.state);
  useEffect(() => {
    if (done) return;
    const controller = new AbortController();
    const watch = async () => {
      for (;;) {
        const since = version.current;
        const next = await watchCopy(first.id, since, controller.signal);
        if (controller.signal.aborted) return;
        version.current = next.version;
        setCopy(next);
        report.current(next);
        if (isCopyDone(next.state)) return;
        if (next.version === since) await new Promise((resolve) => setTimeout(resolve, 1_000, undefined));
        if (controller.signal.aborted) return;
      }
    };
    watch().catch((thrown: unknown) => {
      if (controller.signal.aborted) return;
      const info = thrown instanceof ApiError ? thrown.info : undefined;
      setError(serverMessage(i18n, info?.messageKey ?? 'errors.internal', info?.params));
    });
    return () => controller.abort();
  }, [first.id, done, i18n]);

  if (copy.state === 'failed')
    return (
      <Banner tone="danger">
        {serverMessage(i18n, copy.error?.messageKey ?? 'archives.copy.failed', copy.error?.params)}
      </Banner>
    );
  if (copy.state === 'finished' && copy.report) {
    const { records, tables, attachments, missingAttachments, automations, unsyncedTables } = copy.report;
    return (
      <div className="rio-archives__done" role="status">
        <p>
          {t({
            id: 'archives.copy.done',
            message: plural(tables, {
              one: `Made ${copy.name} with # table and ${records} records.`,
              other: `Made ${copy.name} with # tables and ${records} records.`,
            }),
          })}
        </p>
        {attachments ? (
          <p>
            {t({
              id: 'archives.copy.files',
              message: plural(attachments, { one: '# file was copied.', other: '# files were copied.' }),
            })}
          </p>
        ) : null}
        {missingAttachments ? (
          <Banner tone="warning">
            {t({
              id: 'archives.copy.missingFiles',
              message: plural(missingAttachments, {
                one: '# file was left out because it was deleted after the snapshot was taken.',
                other: '# files were left out because they were deleted after the snapshot was taken.',
              }),
            })}
          </Banner>
        ) : null}
        {copy.report.emptyLinkFields?.map(({ fieldId, tableName, fieldName }) => (
          <Banner key={fieldId} tone="warning">
            {t({
              id: 'archives.copy.emptyLinkField',
              message: `${tableName} → ${fieldName} was copied with empty values because you cannot read its destination table.`,
            })}
          </Banner>
        ))}
        {automations ? (
          <p>
            {t({
              id: 'archives.copy.automationsOff',
              message: plural(automations, {
                one: 'Its automation is turned off, so nothing runs until you turn it on.',
                other: 'Its # automations are turned off, so nothing runs until you turn them on.',
              }),
            })}
          </p>
        ) : null}
        {unsyncedTables ? (
          <p>
            {t({
              id: 'archives.copy.unsynced',
              message: plural(unsyncedTables, {
                one: '# synced table came across as an ordinary table, since its data source is gone or you can’t use it.',
                other:
                  '# synced tables came across as ordinary tables, since their data sources are gone or you can’t use them.',
              }),
            })}
          </p>
        ) : null}
      </div>
    );
  }
  const phase = copy.state === 'queued' ? 'queued' : (copy.progress.phase ?? 'reading');
  const { records, recordsDone } = copy.progress;
  return (
    <div className="rio-archives__progress">
      {phase === 'records' && records > 0 ? (
        <ProgressBar
          value={Math.min(100, Math.round((recordsDone / records) * 100))}
          label={i18n._(PHASES[phase])}
          valueLabel={t({ id: 'archives.copy.records', message: `${recordsDone} of ${records} records` })}
        />
      ) : (
        <ProgressBar isIndeterminate label={i18n._(PHASES[phase])} />
      )}
      <p className="rio-archives__note">
        {t({
          id: 'archives.copy.background',
          message: 'You can close this.  The copy keeps going, and it shows on Home when it’s ready.',
        })}
      </p>
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </div>
  );
}
