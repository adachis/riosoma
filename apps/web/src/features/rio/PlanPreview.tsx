import { LazyBoundary } from '../../shell/lazy';
import { PlanDetails } from './PlanDetails';
import { lazy, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { RioBlock, RioPlanPreview } from '@riosoma/contracts';
import { Button, Checkbox, Dialog, DialogBody, DialogFooter, DialogTitle, Modal, Spinner } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useSchema, useViewRows } from '../../data/hooks';
import { openDatabase } from '../../data/session';
import { MemoryOutboxStore } from '../../data/outbox';
import { beginSandbox, endSandbox, inSandbox } from '../../data/sandbox';
import type { DatabaseSession, SchemaState } from '../../data/types';
import { useSession } from '../../session';
import { useServerMessage } from '../../messages/useServerMessage';
import { GridView } from '../../grid/GridView';
import { VIEW_DEFINITIONS } from '../../screens/database/views/registry';
import { previewHttp } from './preview-data';
import { DatabaseIcon } from '../../screens/home/DatabaseIcon';
import { databaseHref } from '../../screens/database/screen/routes';
import { fieldTypeInfo } from '../../screens/database/fields/fieldTypes';
import './plan-preview.css';

const DashboardScreen = lazy(() =>
  import('../../screens/database/dashboards/DashboardScreen').then((m) => ({ default: m.DashboardScreen })),
);
const InterfaceScreen = lazy(() =>
  import('../../screens/database/interfaces/InterfaceScreen').then((m) => ({ default: m.InterfaceScreen })),
);
const AutomationFlow = lazy(() =>
  import('../../screens/database/automations/AutomationFlow').then((m) => ({ default: m.AutomationFlow })),
);
export const PLAN_APPLIED = 'rio-plan-applied';

export function PlanPreview() {
  const location = useLocation();
  const params = new URLSearchParams(location.searchStr);
  const planId = params.get('rioPreview');
  return planId ? <Preview key={planId} planId={planId} target={params.get('rioPreviewTarget')} /> : null;
}

function Preview({ planId, target }: { planId: string; target: string | null }) {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const location = useLocation();
  const userId = useSession()?.user.id;
  const message = useServerMessage();
  const [session, setSession] = useState<DatabaseSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [includeSamples, setIncludeSamples] = useState(true);
  const snapshot = useQuery({
    queryKey: ['rio', 'preview', planId, includeSamples],
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      api<RioPlanPreview>(
        `/api/rio/plans/${encodeURIComponent(planId)}/preview?timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}&includeSamples=${includeSamples}`,
        { signal },
      ),
  });
  const schema = useSchema(session);
  useEffect(() => {
    if (!snapshot.data || !userId) return;
    let closed = false;
    let ownsSandbox = false;
    let local: DatabaseSession | null = null;
    const data = snapshot.data;
    const open = async () => {
      if (inSandbox())
        throw new ApiError(409, { code: 'conflict', messageKey: 'demos.sandbox.refused', userFault: true });
      beginSandbox();
      ownsSandbox = true;
      return openDatabase(data.schema.database.id, {
        http: previewHttp(data),
        userId,
        outbox: new MemoryOutboxStore(),
        webSocketFactory: () => ({
          send: () => undefined,
          close: () => undefined,
          addEventListener: () => undefined,
        }),
      });
    };
    void open()
      .then((value) => {
        if (closed) {
          value.close();
          return;
        }
        local = value;
        setSession(value);
      })
      .catch((cause: unknown) => {
        if (!closed) setError(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal');
      });
    return () => {
      closed = true;
      local?.close();
      if (ownsSandbox) endSandbox();
    };
  }, [snapshot.data, userId, attempt]);

  function href(next?: string) {
    const search = new URLSearchParams(location.searchStr);
    if (next) search.set('rioPreviewTarget', next);
    else {
      search.delete('rioPreview');
      search.delete('rioPreviewTarget');
    }
    return `${location.pathname}${search.size ? `?${search}` : ''}`;
  }
  function close() {
    if (!busy) void navigate({ href: href() });
  }
  async function apply() {
    if (busy || !session) return;
    setBusy(true);
    setError(null);
    setApplyError(null);
    session.close();
    setSession(null);
    endSandbox();
    try {
      const block = await api<RioBlock>(`/api/rio/plans/${encodeURIComponent(planId)}/apply`, {
        method: 'POST',
        body: { includeSamples },
      });
      window.dispatchEvent(new CustomEvent(PLAN_APPLIED, { detail: block }));
      void navigate({
        href:
          block.kind === 'receipt' && block.createdDatabase && block.databaseId
            ? databaseHref(block.databaseId)
            : href(),
      });
    } catch (cause) {
      setApplyError(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal');
      const refreshed = await snapshot.refetch();
      if (!refreshed.error) setAttempt((value) => value + 1);
      else if (refreshed.error instanceof ApiError && refreshed.error.info.messageKey === 'rio.plan.stale') {
        // A saved approval cannot be previewed again.  Replaying it returns its receipt without another write.
        try {
          const block = await api<RioBlock>(`/api/rio/plans/${encodeURIComponent(planId)}/apply`, {
            method: 'POST',
          });
          window.dispatchEvent(new CustomEvent(PLAN_APPLIED, { detail: block }));
          void navigate({ href: href() });
        } catch (recoveryError) {
          setApplyError(
            recoveryError instanceof ApiError ? recoveryError.info.messageKey : 'errors.internal',
          );
        }
      }
    } finally {
      setBusy(false);
    }
  }
  const targets =
    schema && snapshot.data
      ? snapshot.data.targets.flatMap((id) => {
          const dashboard = schema.dashboardById.get(id);
          const automation = schema.automationById.get(id);
          const view = schema.viewById.get(id);
          const value = schema.interfaceById.get(id);
          if (value)
            return value.pages.map((page) => ({
              id: `${id}/${page.id}`,
              name: `${value.name} · ${page.name}`,
            }));
          const item = dashboard ?? automation ?? view;
          return item
            ? [
                {
                  id,
                  name:
                    snapshot.data.creation && view
                      ? `${schema.tableById.get(view.tableId)?.name} · ${view.name}`
                      : item.name,
                },
              ]
            : [];
        })
      : [];
  const selected = targets.find((item) => item.id === target) ?? targets[0];
  const failure =
    (error ? message(error) : null) ??
    (snapshot.error
      ? message(snapshot.error instanceof ApiError ? snapshot.error.info.messageKey : 'errors.internal')
      : null);
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      className="rio-plan-preview-modal"
    >
      <Dialog className="rio-plan-preview" aria-label={t({ id: 'rio.plan.preview', message: 'Preview' })}>
        <DialogTitle>
          <Trans id="rio.plan.preview">Preview</Trans>
        </DialogTitle>
        <DialogBody>
          {snapshot.data?.creation ? (
            <section>
              <h2>
                <DatabaseIcon database={snapshot.data.schema.database} />
                {snapshot.data.schema.database.name}
              </h2>
              <p>
                {snapshot.data.creation.folderId ? (
                  <Trans id="rio.plan.creation.folder">In {snapshot.data.creation.folderName}</Trans>
                ) : (
                  <Trans id="rio.plan.creation.root">In your home</Trans>
                )}
              </p>
              {snapshot.data.creation.templateName ? (
                <p>
                  <Trans id="rio.plan.creation.template">
                    Based on {snapshot.data.creation.templateName}
                  </Trans>
                </p>
              ) : null}
              <ul>
                {snapshot.data.schema.tables.map((table) => (
                  <li key={table.id}>
                    {table.name}:{' '}
                    {snapshot
                      .data!.schema.fields.filter((field) => field.tableId === table.id)
                      .map((field) => `${field.name} (${i18n._(fieldTypeInfo(field.type).name)})`)
                      .join(', ')}
                  </li>
                ))}
              </ul>
              {snapshot.data.creation.sampleCount ? (
                <Checkbox
                  isSelected={includeSamples}
                  isDisabled={busy || snapshot.isFetching}
                  onChange={(checked) => {
                    setSession(null);
                    setError(null);
                    setIncludeSamples(checked);
                  }}
                >
                  <Trans id="rio.plan.creation.samples">Keep sample records</Trans>
                </Checkbox>
              ) : null}
            </section>
          ) : null}
          <PlanDetails details={snapshot.data?.details} />
          <p>
            <Trans id="rio.plan.preview.note">
              Nothing you try here is saved.{'  '}Apply saves the proposed changes.
            </Trans>
          </p>
          {snapshot.data ? (
            <p>
              <Trans id="rio.plan.preview.rows">
                Record lists show up to {snapshot.data.rowLimit} records across this preview.
              </Trans>
            </p>
          ) : null}
          {failure || applyError ? <p role="alert">{failure ?? message(applyError!)}</p> : null}
          {snapshot.isPending || (!session && !failure && !busy) ? <Spinner /> : null}
          <nav
            aria-label={t({ id: 'rio.plan.preview.changes', message: 'Proposed changes' })}
            className="rio-plan-preview__targets"
          >
            {targets.map((item) => (
              <Button
                key={item.id}
                aria-pressed={selected?.id === item.id}
                onPress={() => void navigate({ href: href(item.id), replace: true })}
              >
                {item.name}
              </Button>
            ))}
          </nav>
          {session && schema && selected ? (
            <div
              className="rio-plan-preview__surface"
              onClickCapture={(event) => {
                const link = (event.target as Element).closest('a');
                if (link) event.preventDefault();
              }}
            >
              <LazyBoundary>
                <Surface session={session} schema={schema} target={selected.id} />
              </LazyBoundary>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button isDisabled={busy} onPress={close}>
            <Trans id="rio.plan.preview.close">Close preview</Trans>
          </Button>
          <Button
            variant="primary"
            isDisabled={
              busy ||
              snapshot.isFetching ||
              !session ||
              Boolean(failure) ||
              (snapshot.data?.external === true && !snapshot.data.details?.length)
            }
            onPress={() => void apply()}
          >
            <Trans id="rio.plan.apply">Apply</Trans>
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}

function Surface({
  session,
  schema,
  target,
}: {
  session: DatabaseSession;
  schema: SchemaState;
  target: string;
}) {
  const [id, pageId] = target.split('/');
  const dashboard = schema.dashboardById.get(id!);
  const automation = schema.automationById.get(id!);
  if (dashboard) return <DashboardScreen key={id} session={session} schema={schema} dashboard={dashboard} />;
  if (automation)
    return (
      <>
        <h2>{automation.name}</h2>
        <p>
          <Trans id="rio.plan.preview.draft">This automation stays a draft until you publish it.</Trans>
        </p>
        <AutomationFlow
          session={session}
          schema={schema}
          automation={automation}
          config={automation.draft?.config ?? automation.config}
          readOnly
          onChange={() => undefined}
        />
      </>
    );
  if (schema.interfaceById.has(id!))
    return (
      <InterfaceScreen
        key={target}
        session={session}
        schema={schema}
        interfaceId={id!}
        pageId={pageId}
        fallbackHref="/"
        preview
      />
    );
  return <ViewSurface key={id} session={session} schema={schema} id={id!} />;
}

function ViewSurface({ session, schema, id }: { session: DatabaseSession; schema: SchemaState; id: string }) {
  const { i18n } = useLingui();
  const view = schema.viewById.get(id);
  const rows = useViewRows(session, view?.type === 'grid' ? id : null);
  const table = view && schema.tableById.get(view.tableId);
  if (!view || !table) return null;
  const fields = schema.fields.get(table.id) ?? [];
  const format = {
    locale: i18n.locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    collaborators: schema.collaborators,
    fieldsById: schema.fieldById,
    linked: session.linked,
    attachments: session.attachments,
  };
  const props = {
    session,
    view,
    table,
    fields,
    format,
    canEdit: false,
    onConfig: () => undefined,
    onExpand: () => undefined,
  };
  const Component = VIEW_DEFINITIONS[view.type].View;
  return Component ? (
    <Component {...props} />
  ) : rows ? (
    <GridView {...props} rows={rows} peers={[]} onField={() => undefined} onFilter={() => undefined} />
  ) : (
    <Spinner />
  );
}
