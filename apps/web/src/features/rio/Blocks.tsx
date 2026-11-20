import { PlanDetails } from './PlanDetails';
import { RemoteApproval } from './RemoteApproval';
import { GatewayErrorMessage } from './GatewayErrorMessage';
import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  cellValue,
  newId,
  type DatabaseSchema,
  type DatabaseSummary,
  type RowData,
  type RioBlock,
  type RioCreated,
  type RioUsage,
  type UndoResult,
  type TableCopyJob,
} from '@riosoma/contracts';
import { Button, Link, Spinner } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { clientId } from '../../data/deps';
import { SchemaModel } from '../../data/state';
import { useSchema } from '../../data/hooks';
import type { DatabaseSession } from '../../data/types';
import { formatCell } from '../../grid/format';
import { undoSkipped } from '../../grid/view/actions';
import { confirmMajorUndo } from '../../data/undo-confirmation';
import { useServerMessage } from '../../messages/useServerMessage';
import { databaseHref, dashboardHref, interfaceHref } from '../../screens/database/screen/routes';
import { Markdown } from './Markdown';
import { FootprintLine } from '../ai-footprint/FootprintLine';

type BlockProps = {
  block: RioBlock;
  canManage?: boolean;
  session: DatabaseSession | null;
  disabled: boolean;
  onAnswer(text: string): void;
  onReplace(block: RioBlock): void;
  onReceipt(): void;
  onError(): void;
};

export function Block({
  block,
  canManage = false,
  session,
  disabled,
  onAnswer,
  onReplace,
  onReceipt,
  onError,
}: BlockProps) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const message = useServerMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandId = useRef(newId('command'));
  const jobId = block.kind === 'receipt' ? block.jobId : undefined;
  const copy = useQuery({
    queryKey: ['duplicate-job', jobId],
    queryFn: () => api<TableCopyJob>(`/api/duplicate-jobs/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 500 : false),
  });
  const completedJob = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (jobId && copy.data?.state === 'finished' && completedJob.current !== jobId) {
      completedJob.current = jobId;
      onReceipt();
    }
  }, [jobId, copy.data?.state, onReceipt]);
  async function cancelCopy() {
    setBusy(true);
    try {
      await api(`/api/duplicate-jobs/${jobId}/cancel`, { method: 'POST' });
      await copy.refetch();
    } catch (cause) {
      setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
    } finally {
      setBusy(false);
    }
  }
  async function action(kind: 'apply' | 'dismiss' | 'undo') {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'undo' && block.kind === 'receipt') {
        if (block.databaseId && !(await confirmMajorUndo(block.databaseId, block.groupId))) return;
        const result =
          block.databaseId === null
            ? await api<UndoResult>(`/api/home/undo/${encodeURIComponent(block.groupId)}`, {
                method: 'POST',
                body: { id: commandId.current },
              })
            : await api<UndoResult>(`/api/databases/${encodeURIComponent(block.databaseId)}/undo`, {
                body: {
                  clientId: clientId(),
                  groupId: block.groupId,
                  commandId: commandId.current,
                  confirmedMajorCreation: true,
                },
              });
        if (result.status === 'rejected') {
          setError(message(result.error?.messageKey ?? 'errors.internal', result.error?.params));
          onError();
        } else {
          onReplace({ ...block, undone: true });
          if (result.skipped || result.pending) undoSkipped(result.skipped, result.pending);
          if (block.createdDatabase && !result.skipped && !result.pending) void navigate({ href: '/' });
        }
      } else if (block.kind === 'plan') {
        const result = await api<RioBlock>(`/api/rio/plans/${encodeURIComponent(block.planId)}/${kind}`, {
          method: 'POST',
        });
        if (kind === 'dismiss') onReplace({ ...block, status: 'dismissed' });
        else if (result?.kind === 'receipt') {
          onReplace(result);
          onReceipt();
          if (result.createdDatabase && result.databaseId)
            void navigate({ href: databaseHref(result.databaseId) });
        } else {
          setError(message(result?.kind === 'error' ? result.messageKey : 'errors.internal'));
          onError();
        }
      }
    } catch (cause) {
      setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
      onError();
    } finally {
      setBusy(false);
    }
  }
  if (block.kind === 'remoteApproval') return <RemoteApproval id={block.approvalId} disabled={disabled} />;
  if (block.kind === 'sources')
    return (
      <section>
        <h3 data-anchor="knowledge.sources">
          <Trans id="knowledge.sources">Sources</Trans>
        </h3>
        <ul>
          {block.sources
            .filter((source) => /^https?:\/\//i.test(source.url))
            .map((source) => (
              <li key={source.url}>
                <Link href={source.url} target="_blank" rel="noopener noreferrer">
                  {source.title || source.url}
                </Link>
              </li>
            ))}
        </ul>
      </section>
    );
  if (block.kind === 'text' || block.kind === 'attention') return <Markdown text={block.text} />;
  if (block.kind === 'notice') return <p role="status">{message(block.messageKey)}</p>;
  if (block.kind === 'error')
    return (
      <p role="alert">
        <GatewayErrorMessage {...block} canManage={canManage} />
      </p>
    );
  if (block.kind === 'records') return <Records block={block} session={session} />;
  if (block.kind === 'questions')
    return (
      <div className="rio-assistant__block">
        <Markdown text={block.prompt} />
        <div className="rio-assistant__actions">
          {block.options.map((option, index) => (
            <Button key={index} isDisabled={disabled} onPress={() => onAnswer(option)}>
              {option}
            </Button>
          ))}
        </div>
      </div>
    );
  return (
    <div className="rio-assistant__block">
      <Markdown text={block.summary} />
      {block.kind === 'plan' ? (
        <>
          <ol>
            {block.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
          <PlanDetails details={block.details} />
          {block.status === 'pending' ? (
            <div className="rio-assistant__actions">
              {block.preview ? (
                <Link href={`?rioPreview=${encodeURIComponent(block.planId)}`}>
                  <Trans id="rio.plan.preview">Preview</Trans>
                </Link>
              ) : null}
              <Button
                isDisabled={disabled || busy || (block.external === true && !block.details?.length)}
                onPress={() => void action('apply')}
              >
                <Trans id="rio.plan.apply">Apply</Trans>
              </Button>
              <Button isDisabled={disabled || busy} onPress={() => void action('dismiss')}>
                <Trans id="rio.plan.dismiss">Dismiss</Trans>
              </Button>
            </div>
          ) : block.status === 'applied' ? (
            <Trans id="rio.plan.applied">Applied</Trans>
          ) : block.status === 'dismissed' ? (
            <Trans id="rio.plan.dismissed">Dismissed</Trans>
          ) : (
            <p role="alert">{message(block.messageKey ?? 'errors.internal')}</p>
          )}
        </>
      ) : block.undone ? (
        <p role="status">
          <Trans id="rio.receipt.undone">Undone</Trans>
        </p>
      ) : jobId && copy.data?.state !== 'finished' ? (
        <>
          {copy.data?.state === 'failed' || copy.data?.state === 'canceled' || copy.error ? (
            <p role="alert">
              {message(
                copy.data?.result?.error?.messageKey ??
                  (copy.data?.state === 'canceled' ? 'duplicate.table.canceled' : 'errors.internal'),
              )}
            </p>
          ) : (
            <>
              <p role="status">
                {copy.data
                  ? t({
                      id: 'duplicate.table.progress',
                      message: `Copied ${copy.data.copied} of ${copy.data.total} records`,
                    })
                  : t({ id: 'duplicate.table.starting', message: 'Copying table…' })}
              </p>
              <Button isDisabled={disabled || busy} onPress={() => void cancelCopy()}>
                <Trans id="duplicate.table.cancel">Cancel copy</Trans>
              </Button>
            </>
          )}
        </>
      ) : (
        <div className="rio-assistant__actions">
          {block.databaseId && block.createdDatabase ? (
            <Link href={databaseHref(block.databaseId)}>
              <Trans id="rio.receipt.openDatabase">Open database</Trans>
            </Link>
          ) : null}
          {block.databaseId && block.created?.length ? (
            <CreatedLinks databaseId={block.databaseId} created={block.created} />
          ) : null}
          <Button isDisabled={disabled || busy} onPress={() => void action('undo')}>
            <Trans id="rio.receipt.undo">Undo</Trans>
          </Button>
        </div>
      )}
      {busy && <Spinner />}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** Links on a receipt to each thing the plan created, so a person can open it with the panel open. */
function CreatedLinks({ databaseId, created }: { databaseId: string; created: RioCreated[] }) {
  const { t } = useLingui();
  const counts = created.reduce<Record<string, number>>((totals, item) => {
    totals[item.kind] = (totals[item.kind] ?? 0) + 1;
    return totals;
  }, {});
  const hrefFor = (item: RioCreated): string => {
    switch (item.kind) {
      case 'table':
        return databaseHref(databaseId, item.id);
      case 'view':
        return databaseHref(databaseId, item.tableId, item.id);
      case 'dashboard':
        return dashboardHref(databaseId, item.id);
      case 'interface':
        return interfaceHref(databaseId, item.id);
    }
  };
  const labelFor = (item: RioCreated): string => {
    const base = {
      table: t({ id: 'rio.receipt.openTable', message: 'Open table' }),
      view: t({ id: 'rio.receipt.openView', message: 'Open view' }),
      dashboard: t({ id: 'rio.receipt.openDashboard', message: 'Open dashboard' }),
      interface: t({ id: 'rio.receipt.openInterface', message: 'Open interface' }),
    }[item.kind];
    // Name the item only when the receipt has more than one of its kind, so two links never match.
    return (counts[item.kind] ?? 0) > 1 ? `${base}: ${item.name}` : base;
  };
  return (
    <>
      {created.map((item) => (
        <Link key={`${item.kind}-${item.id}`} href={hrefFor(item)}>
          {labelFor(item)}
        </Link>
      ))}
    </>
  );
}

function Records({
  block,
  session,
}: {
  block: Extract<RioBlock, { kind: 'records' }>;
  session: DatabaseSession | null;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const currentSchema = useSchema(session);
  const local = currentSchema?.tableById.has(block.tableId) ?? false;
  const discovered = useQuery({
    queryKey: ['rio', 'table', block.tableId],
    enabled: !local,
    queryFn: async ({ signal }) => {
      // Record blocks carry a table ID. History can be opened outside its original database.
      const databases = await api<DatabaseSummary[]>('/api/databases', { signal });
      for (const database of databases) {
        try {
          const candidate = await api<DatabaseSchema>(
            `/api/databases/${encodeURIComponent(database.id)}/schema`,
            { signal },
          );
          if (candidate.tables.some((table) => table.id === block.tableId))
            return new SchemaModel(candidate).snapshot();
        } catch (cause) {
          if (!(cause instanceof ApiError && (cause.status === 403 || cause.status === 404))) throw cause;
        }
      }
      return null;
    },
  });
  const schema = local ? currentSchema : discovered.data;
  const table = schema?.tableById.get(block.tableId);
  const records = useQuery({
    queryKey: ['rio', 'records', schema?.database.id, block.tableId, block.recordIds],
    queryFn: ({ signal }) =>
      Promise.all(
        block.recordIds.map(async (id) => {
          if (local && session) return session.getRecord(block.tableId, id);
          try {
            return await api<RowData>(
              `/api/tables/${encodeURIComponent(block.tableId)}/records/${encodeURIComponent(id)}`,
              { signal },
            );
          } catch (cause) {
            if (cause instanceof ApiError && cause.status === 404) return null;
            throw cause;
          }
        }),
      ),
    enabled: Boolean(table),
  });
  if (!local && discovered.isPending) return <Spinner />;
  if (!schema || !table)
    return <p role="alert">{message(discovered.error ? 'errors.internal' : 'errors.notFound')}</p>;
  if (records.isPending) return <Spinner />;
  if (records.error) return <p role="alert">{message('errors.internal')}</p>;
  const fields = [...new Set(block.fieldIds)]
    .filter((id) => id !== table.primaryFieldId)
    .flatMap((id) => {
      const field = schema.fieldById.get(id);
      return field && field.tableId === table.id ? [field] : [];
    })
    .slice(0, 3);
  const format = {
    locale: i18n.locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    collaborators: schema.collaborators,
    fieldsById: schema.fieldById,
    linked: local ? session?.linked : undefined,
    attachments: local ? session?.attachments : undefined,
  };
  const primary = schema.fieldById.get(table.primaryFieldId);
  const view = schema.views.get(table.id)?.[0];
  const rows = records.data?.flatMap((row) => (row ? [row] : [])) ?? [];
  const count = i18n.number(rows.length);
  const total = i18n.number(block.total ?? block.recordIds.length);
  const tableName = table.name;
  const databaseName = schema.database.name;
  const label = t({
    id: 'rio.records.summary',
    message: `${count} of ${total} records in ${tableName} · ${databaseName}`,
  });
  const title = (row: RowData) => (primary ? formatCell(primary, cellValue(row, primary), format) : row.id);
  const value = (text: string) => (
    <span className="rio-assistant__value" title={text} aria-label={text}>
      {text}
    </span>
  );
  const open = (row: RowData) => {
    const name = title(row);
    // The link's name starts with its visible text, then keeps the record it opens.
    const openText = t({ id: 'rio.record.openLink', message: 'Open record' });
    return (
      <Link
        href={databaseHref(schema.database.id, table.id, view?.id, row.id)}
        aria-label={t({ id: 'rio.record.open', message: `${openText}: ${name}` })}
      >
        <Trans id="rio.record.openLink">Open record</Trans>
      </Link>
    );
  };
  return (
    <section className="rio-assistant__records" aria-label={label}>
      <p>{label}</p>
      <ul className="rio-assistant__record-cards">
        {rows.map((row) => (
          <li key={row.id}>
            <h3>{value(title(row))}</h3>
            <dl>
              {fields.map((field) => (
                <div key={field.id}>
                  <dt>{value(field.name)}</dt>
                  <dd>{value(formatCell(field, cellValue(row, field), format))}</dd>
                </div>
              ))}
            </dl>
            {open(row)}
          </li>
        ))}
      </ul>
      <div className="rio-assistant__record-table" data-columns={fields.length + 1}>
        <div className="rio-assistant__table-scroll" role="region" tabIndex={0} aria-label={label}>
          <table className="rio-assistant__table">
            <caption className="rio-visually-hidden">{label}</caption>
            <thead>
              <tr>
                <th scope="col">{value(primary?.name ?? table.name)}</th>
                {fields.map((field) => (
                  <th scope="col" key={field.id}>
                    {value(field.name)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    {value(title(row))}
                    {open(row)}
                  </th>
                  {fields.map((field) => (
                    <td key={field.id}>{value(formatCell(field, cellValue(row, field), format))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function Usage({ usage }: { usage: RioUsage }) {
  const { t, i18n } = useLingui();
  const model = usage.model;
  const tokens = i18n.number(usage.inputTokens + usage.outputTokens);
  const cost =
    usage.costUsd === null
      ? null
      : i18n.number(usage.costUsd, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
  return (
    <>
      <p className="rio-assistant__quiet">
        {cost === null
          ? t({ id: 'rio.usage', message: `${model} · ${tokens} tokens` })
          : t({ id: 'rio.usage.cost', message: `${model} · ${tokens} tokens · ${cost}` })}
      </p>
      {usage.footprint === undefined ? null : <FootprintLine footprint={usage.footprint} />}
    </>
  );
}
