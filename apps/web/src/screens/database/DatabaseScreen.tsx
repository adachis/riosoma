import { lazyFeature, LazyBoundary } from '../../shell/lazy';
import { NamedFunctionsScreen } from './named-functions/NamedFunctionsScreen';
import { namedFunctionsHref } from './screen/routes';
import { dashboardFiltersToken, parseDashboardFilters } from './dashboards/filters';
import { availableViewName } from './screen/view-name';
import { SidebarNavigationProvider } from './shell/SidebarOrder';
import { useHomeShortcutDrop } from '../home/shortcuts';
import { faShareNodes } from '@fortawesome/free-solid-svg-icons';
import { ResponsiveToolbar } from '../../components/ResponsiveToolbar';
import { viewHelp } from '../../docs/view-help';
import { TableDataControls } from './joins/TableDataControls';
import { SqlLauncher } from './sql/SqlScreen';
import { useQuery } from '@tanstack/react-query';
import type { SourceMeta } from '@riosoma/contracts';
import { api, ApiError } from '../../api';
import { useSession } from '../../session';
import { SyncWizard } from './synced/SyncWizard';
import { SyncStatus } from './synced/SyncStatus';
import { JoinsDialog } from './joins/JoinsDialog';
import { DuplicatesPanel } from './dedupe/DuplicatesPanel';
import { TrashDialog } from '../trash/TrashDialog';
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Link,
  useNavigate,
  useParams,
  useMatch,
  useSearch,
  useLocation,
  useRouter,
} from '@tanstack/react-router';
import {
  decodeWhere,
  idKind,
  isCalendarFeedViewType,
  liveAllowsType,
  newId,
  readsSourceLive,
  roleAllows,
  FIELD_TYPES,
  VIEW_TYPES,
  type FieldType,
  type TableMeta,
  type ViewMeta,
  type ViewType,
  type DatabaseSchema,
  type DatabaseSummary,
} from '@riosoma/contracts';
import { ConfirmProvider, toast } from '@riosoma/ui';
import {
  useDatabaseSession,
  usePeers,
  useSaveState,
  useSchema,
  useSessionEvents,
  useViewRows,
} from '../../data/hooks';
import type { DatabaseSession, SchemaState, SessionEvent } from '../../data/types';
import { GridView } from '../../grid/GridView';
import { LiveNotice } from './synced/LiveNotice';
import { reportError, undoSkipped } from '../../grid/view/actions';
import { serverMessage } from '../../messages/useServerMessage';
import { rememberPlace } from '../../palette/recent';
import { usePaletteItems } from '../../palette/sources';
import type { PaletteItem } from '../../palette/types';
import { AppSidebar } from '../../shell/AppShell';
import { paletteItems } from './screen/paletteItems';
import { DatabaseHeader } from './shell/DatabaseHeader';
import { PresenceBar } from './shell/PresenceBar';
import { SaveIndicator } from './shell/SaveIndicator';
import { TableSidebar } from './shell/TableSidebar';
import { ViewTabs } from './shell/ViewTabs';
import { NarrowedNotice } from './view/NarrowedNotice';
import { ToolbarSettings } from './view/ToolbarSettings';
import { ViewToolbar } from './view/ViewToolbar';
import { useViewDownload } from './view/download';
import { OfficeDownloadDialog } from './view/OfficeDownloadDialog';
import { ShareDialog } from './share/ShareDialog';
import { anchor } from '../../demos/anchors';
import { ShareViewDialog } from './share-view/ShareViewDialog';
import { ImportDialog, ImportIntoTable, reportTitle, usePlatformReport } from '../import';
import { useAirtableReport } from '../import';
import { VIEW_DEFINITIONS } from './views/registry';
import type { ViewComponentProps } from './views/types';
import { FieldOverlay } from './screen/FieldOverlay';
import { RecordOverlay } from './screen/RecordOverlay';
import { recordPageHref } from './screen/routes';
import { useSavePreferences } from '../settings/usePreferences';
import {
  automationHref,
  dashboardHref,
  databaseHref,
  resolveDatabasePath,
  type DatabasePath,
} from './screen/routes';
import { useViewConfig } from './screen/useViewConfig';
import { useViewColors } from './colors/useViewColors';
import { AutomationSidebar } from './automations/AutomationList';
import { InterfaceSidebar } from './interfaces/InterfaceSidebar';
import { ScriptSidebar } from './scripts/ScriptSidebar';
import { RoutineSidebar } from '../../features/routines/RoutineSidebar';
import { DatabaseSettingsMenu, WebhooksDialog } from './webhooks/WebhooksDialog';
import { isOrgAdmin } from '../../features/archives/api';
import { DuplicateDialog } from '../../features/archives/DuplicateDialog';
import { SaveTemplateDialog } from '../../features/archives/SaveTemplateDialog';
import { SnapshotsDialog } from '../../features/archives/SnapshotsDialog';
import { DatabaseThemeDialog, useDatabaseTheme } from '../../features/themes/DatabaseTheme';
import { UndoHistoryButton } from './undo/UndoHistoryButton';
import { printMenu } from './print/messages';
import { reportsMenu } from '../../features/reports/words';
import { syncOutLabel } from '../../features/sync-out/words';
import { subscribeMenu } from '../../features/calendar-feeds/words';
import { isPrintableViewType } from './print/options';
import { FieldPermissionsDialog } from './permissions/FieldPermissionsDialog';
import { RecordAccessDialog } from './permissions/RecordAccessDialog';
import { RestrictedFields } from './permissions/restricted';
import { useSessionCelebrations } from '../../features/celebrations/watchers';
import { HoldingsProvider } from '../../levels/context';
import { TrashWindowProvider } from '../../features/retention/window';
import { databaseHoldings } from '../../levels/holdings';
import { useFeatureCommands } from '../../levels/palette';
import './screen/screen.css';

// Dashboards and their charts load only when a dashboard opens.
const DuplicateActionDialog = lazyFeature(() =>
  import('./screen/DuplicateDialog').then((module) => ({ default: module.DuplicateDialog })),
);
const DashboardScreen = lazyFeature(() =>
  import('./dashboards').then((module) => ({ default: module.DashboardScreen })),
);
const RoutineScreen = lazyFeature(() =>
  import('../../features/routines/RoutineScreen').then((module) => ({ default: module.RoutineScreen })),
);
const AutomationScreen = lazyFeature(() =>
  import('./automations/AutomationScreen').then((module) => ({ default: module.AutomationScreen })),
);
// Printing, and the PDF library behind it, load only when someone prints.
const CalendarFeedDialog = lazyFeature(() =>
  import('../../features/calendar-feeds/CalendarFeedDialog').then((module) => ({
    default: module.CalendarFeedDialog,
  })),
);
const ReportsDialog = lazyFeature(() =>
  import('../../features/reports/ReportsDialog').then((module) => ({ default: module.ReportsDialog })),
);
const SyncOutDialog = lazyFeature(() =>
  import('../../features/sync-out/SyncOutDialog').then((module) => ({ default: module.SyncOutDialog })),
);
const BookingPagesDialog = lazyFeature(() =>
  import('../../features/booking-pages/BookingPagesDialog').then((module) => ({
    default: module.BookingPagesDialog,
  })),
);
const PrintViewDialog = lazyFeature(() =>
  import('./print/PrintViewDialog').then((module) => ({ default: module.PrintViewDialog })),
);
const InterfaceScreen = lazyFeature(() =>
  import('./interfaces').then((module) => ({ default: module.InterfaceScreen })),
);
// The script panel, and the code editor in it, load when someone opens a script.
const ScriptPanel = lazyFeature(() =>
  import('./scripts/ScriptPanel').then((module) => ({ default: module.ScriptPanel })),
);

function preloadDatabaseDestination(event: { target: EventTarget | null }) {
  const href = event.target instanceof Element ? event.target.closest('a')?.getAttribute('href') : null;
  if (!href) return;
  if (href.includes('/dashboards/')) DashboardScreen.preload();
  else if (href.includes('/automations/')) AutomationScreen.preload();
  else if (href.includes('/interfaces/')) InterfaceScreen.preload();
  else if (href.includes('/routines/')) RoutineScreen.preload();
}

export function DatabaseUnavailable() {
  return (
    <div className="rio-database-unavailable">
      <p>
        <Trans id="database.notFound">This database doesn’t exist, or you don’t have access to it.</Trans>
      </p>
      <Link to="/">
        <Trans id="database.home">Home</Trans>
      </Link>
    </div>
  );
}

class DatabaseBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <DatabaseUnavailable /> : this.props.children;
  }
}

function FramePlaceholder() {
  const homeDrop = useHomeShortcutDrop();
  const { t } = useLingui();
  return (
    <section
      className="rio-database-screen"
      onMouseOverCapture={preloadDatabaseDestination}
      onFocusCapture={preloadDatabaseDestination}
      role="group"
      aria-busy="true"
      aria-label={t({ id: 'record.loading', message: 'Loading record' })}
    >
      <AppSidebar>
        <Link to="/" className="rio-shell__nav-item" {...anchor('shell.home')} {...homeDrop}>
          <Trans id="database.home">Home</Trans>
        </Link>
        <div className="rio-database-placeholder rio-database-placeholder--sidebar" />
      </AppSidebar>
      <div className="rio-database-placeholder rio-database-placeholder--header" />
      <div className="rio-database-placeholder rio-database-placeholder--controls" />
      <div className="rio-database-placeholder rio-database-placeholder--grid" />
    </section>
  );
}

export function DatabaseScreen() {
  const params = useParams({ strict: false });
  const location = useLocation();
  const page = useMatch({ from: '/app/$databaseId/$tableId/$viewId/$recordId/page', shouldThrow: false });
  const databaseId = params.databaseId ?? '';
  if (idKind(databaseId) !== 'database') return <DatabaseUnavailable />;
  return (
    <DatabaseBoundary key={databaseId}>
      <TrashWindowProvider databaseId={databaseId}>
        <ConfirmProvider>
          <OpenDatabase
            path={{
              databaseId,
              tableId: params.tableId,
              viewId: params.viewId,
              recordId: params.recordId,
              recordSuffix: page
                ? 'page'
                : [params.recordSuffix, params._splat].filter(Boolean).join('/') || undefined,
              dashboardId: params.dashboardId,
              automationId: params.automationId,
              namedFunctions: location.pathname.split('/')[2] === 'named-functions',
              functionId: params.functionId,
              routineId: params.routineId,
              interfaceId: params.interfaceId,
              pageId: params.pageId,
            }}
          />
        </ConfirmProvider>
      </TrashWindowProvider>
    </DatabaseBoundary>
  );
}

function OpenDatabase({ path }: { path: DatabasePath }) {
  const homeDrop = useHomeShortcutDrop();
  const [duplicateTableId, setDuplicateTableId] = useState<string | null>(null);
  const session = useDatabaseSession(path.databaseId);
  const schema = useSchema(session);
  const save = useSaveState(session);
  const peers = usePeers(session);
  const navigate = useNavigate();
  const { t, i18n } = useLingui();
  const [sharing, setSharing] = useLinkedPanel('share');
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const [archive, setArchive] = useState<'snapshots' | 'duplicate' | 'template' | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [importTarget, setImportTarget] = useLinkedPanel('import');
  const importing = importTarget === 'new';
  const importingInto = importTarget && importTarget !== 'new' ? importTarget : null;
  const setImporting = (open: boolean) => setImportTarget(open ? 'new' : null);
  const setImportingInto = (tableId: string | null) => setImportTarget(tableId);
  const [syncing, setSyncing] = useState(false);
  const [findingLinks, setFindingLinks] = useState<string | null>(null);
  const [findingDuplicates, setFindingDuplicates] = useLinkedPanel('duplicates');
  const [recordAccess, setRecordAccess] = useLinkedPanel('recordLocks');
  const [bookingPages, setBookingPages] = useState<string | null>(null);
  const [scriptOpen, setScriptOpen] = useLinkedPanel('script');
  const [settingsPanel, setSettingsPanel] = useLinkedPanel('settings');
  // The database's own theme shows while it's open, and the person's own comes back when they leave.
  const shownTheme = useDatabaseTheme(path.databaseId, schema?.database.theme);
  // The part of a dashboard chart whose records are open, so a link reopens the same list.
  const [drill, setDrill] = useLinkedPanel('drill');
  const [filtersToken, setFiltersToken] = useLinkedPanel('dashboardFilters');
  const dashboardFilters = useMemo(() => parseDashboardFilters(filtersToken), [filtersToken]);
  const [scriptRun, setScriptRun] = useState<{
    id: string;
    key: number;
    button: { tableId: string; recordId: string; fieldId: string };
  } | null>(null);
  useEffect(() => {
    if (!session || !schema) return;
    const run = (event: Event) => {
      const { fieldId, recordId } = (event as CustomEvent<{ fieldId: string; recordId: string }>).detail;
      const field = schema.fieldById.get(fieldId);
      if (field?.type !== 'button') return;
      const action = field.options.action;
      if (!roleAllows(session.role(), action.kind === 'runAutomation' ? 'editSchema' : 'editRecords')) {
        toast.show({ title: serverMessage(i18n, 'data.access.denied'), tone: 'danger' });
        return;
      }
      if (action.kind === 'runScript' && schema.scriptById.has(action.scriptId)) {
        setScriptRun({
          id: action.scriptId,
          key: Date.now(),
          button: { tableId: field.tableId, recordId, fieldId },
        });
        setScriptOpen(action.scriptId);
      } else if (action.kind === 'runAutomation') {
        void session
          .run([{ kind: 'button.run', fieldId, recordId }])
          .done.then((result) => {
            if (!result.rejected)
              toast.show({
                title: t({ id: 'fields.button.queued', message: 'Automation queued.' }),
                tone: 'info',
              });
          })
          .catch(reportError);
      }
    };
    window.addEventListener('rio-button-run', run);
    return () => window.removeEventListener('rio-button-run', run);
  }, [session, schema, setScriptOpen, i18n, t]);
  const closeDuplicates = useCallback(() => setFindingDuplicates(null), [setFindingDuplicates]);
  const person = useSession();
  const sourceAdmin =
    person?.membership.kind === 'owner' || Boolean(person?.membership.adminRoles.includes('data_sources'));
  const readMetadata = Boolean(
    person && !person.demo && schema && roleAllows(schema.database.role, 'editSchema'),
  );
  const sources =
    useQuery({
      queryKey: ['sources'],
      queryFn: () => api<SourceMeta[]>('/api/sources'),
      enabled: readMetadata,
    }).data ?? [];
  const airtableReport = useAirtableReport(path.databaseId, readMetadata);
  const platformReport = usePlatformReport(path.databaseId, readMetadata);
  const repaired = useRef('');
  const handleEvent = useCallback(
    (event: SessionEvent) => {
      if (event.kind === 'rejected') {
        if (!event.handled)
          toast.show({ title: serverMessage(i18n, event.messageKey, event.params), tone: 'danger' });
      } else if (event.kind === 'undoSkipped') undoSkipped(event.skipped, event.pending);
      else if (event.kind === 'reloaded' || event.kind === 'trashed' || event.kind === 'accessLost') {
        const title =
          event.kind === 'reloaded'
            ? event.reason === 'accessChanged'
              ? t({
                  id: 'session.accessChanged',
                  message: 'What you can see or change in this database changed, so it was reloaded.',
                })
              : t({
                  id: 'session.reloaded',
                  message: 'This database changed a lot while you were away, so it was reloaded.',
                })
            : event.kind === 'trashed'
              ? t({ id: 'session.trashed', message: 'This database was deleted.' })
              : t({ id: 'session.accessLost', message: 'You no longer have access to this database.' });
        toast.show({ title, tone: 'info' });
        if (event.kind !== 'reloaded') void navigate({ to: '/' });
      }
    },
    [i18n, navigate, t],
  );
  useSessionEvents(session, handleEvent);
  useSessionCelebrations(session);
  const resolved = schema ? resolveDatabasePath(schema, path) : null;
  const table = resolved?.table;
  const view = resolved?.view;
  const stale = resolved?.stale ?? false;
  const recordId = resolved?.recordId;
  const onDashboard = path.dashboardId !== undefined;
  const onInterface = path.interfaceId !== undefined;
  // A routine's page, like an interface's, isn't one of the tables' views.
  const onRoutine = path.routineId !== undefined;
  const dashboard = onDashboard ? schema?.dashboardById.get(path.dashboardId ?? '') : undefined;
  // A dashboard this person just deleted leaves without the "link fixed" notice.
  const leaving = useRef<string | null>(null);
  const automation = path.automationId ? schema?.automationById.get(path.automationId) : undefined;
  const fixedToast = useCallback(() => {
    toast.show({
      tone: 'info',
      title: t({
        id: 'database.linkFixed',
        message: 'That link pointed to something that no longer exists, so here’s the closest match.',
      }),
    });
  }, [t]);
  useEffect(() => {
    if (
      !table ||
      !view ||
      path.namedFunctions ||
      path.dashboardId !== undefined ||
      path.automationId ||
      onInterface ||
      onRoutine
    )
      return;
    if (path.tableId === table.id && path.viewId === view.id && path.recordId === recordId && !stale) {
      repaired.current = '';
      return;
    }
    const previous = databaseHref(path.databaseId, path.tableId, path.viewId, path.recordId);
    if (repaired.current === previous) return;
    repaired.current = previous;
    if (stale) fixedToast();
    void navigate({
      to: databaseHref(path.databaseId, table.id, view.id, recordId),
      replace: true,
      search: (previous: Record<string, unknown>) => previous,
    });
  }, [
    path.databaseId,
    path.tableId,
    path.viewId,
    path.recordId,
    path.recordSuffix,
    path.dashboardId,
    path.automationId,
    path.namedFunctions,
    onInterface,
    onRoutine,
    table,
    view,
    recordId,
    stale,
    navigate,
    fixedToast,
  ]);
  // An automation that no longer exists sends the link to the database's first view.
  useEffect(() => {
    if (!path.automationId || !table || !view || automation) return;
    const previous = automationHref(path.databaseId, path.automationId);
    if (repaired.current === previous) return;
    repaired.current = previous;
    fixedToast();
    void navigate({ to: databaseHref(path.databaseId, table.id, view.id), replace: true });
  }, [path.automationId, path.databaseId, table, view, automation, navigate, fixedToast]);
  useEffect(() => {
    if (!schema || path.dashboardId === undefined || dashboard || !table || !view) return;
    // Deleting the open dashboard already went to the table.
    if (leaving.current === path.dashboardId) return;
    const previous = dashboardHref(path.databaseId, path.dashboardId);
    if (repaired.current === previous) return;
    repaired.current = previous;
    fixedToast();
    void navigate({ to: databaseHref(path.databaseId, table.id, view.id), replace: true });
  }, [schema, path.databaseId, path.dashboardId, dashboard, table, view, navigate, fixedToast]);
  useEffect(() => {
    if (path.dashboardId !== leaving.current) leaving.current = null;
  }, [path.dashboardId]);
  useEffect(() => {
    // An automation's page sets its own title below, and an interface's sets its own.
    if (!table || !view || !schema || path.namedFunctions || path.automationId || onInterface || onRoutine)
      return;
    const previous = document.title;
    const database = schema.database.name;
    const titleTable = table.name;
    const titleView = view.name;
    document.title = dashboard
      ? i18n._({
          ...msg({ id: 'dashboards.pageTitle', message: '{dashboard} – {database}' }),
          values: { dashboard: dashboard.name, database },
        })
      : i18n._({
          ...msg({ id: 'database.title', message: '{view} – {table} – {database}' }),
          values: { view: titleView, table: titleTable, database },
        });
    return () => {
      document.title = previous;
    };
  }, [
    table?.name,
    view?.name,
    schema?.database.name,
    i18n,
    table,
    view,
    schema,
    dashboard,
    path.automationId,
    path.namedFunctions,
    onInterface,
    onRoutine,
  ]);
  // The palette offers this database's tables and views for as long as it is the open one, and
  // stops the moment it isn't.
  const places = useMemo<PaletteItem[]>(
    () => (schema ? paletteItems(schema, path.databaseId, i18n) : []),
    [schema, path.databaseId, i18n],
  );
  usePaletteItems('database', places);
  // Where this screen is becomes the top of the palette's recent places, so getting back here is
  // one keystroke away however the person got here in the first place.
  const remembered = useRef('');
  useEffect(() => {
    // An automation's screen isn't one of the table's views, so it doesn't count as visiting one.
    if (
      !view ||
      path.namedFunctions ||
      path.automationId ||
      path.dashboardId !== undefined ||
      onInterface ||
      onRoutine
    )
      return;
    const place = places.find((item) => item.id === view.id);
    if (!place || remembered.current === place.path) return;
    remembered.current = place.path;
    rememberPlace({
      id: view.id,
      kind: 'views',
      label: place.label,
      secondary: place.secondary,
      path: place.path,
    });
  }, [view, places, path.automationId, path.namedFunctions, path.dashboardId, onInterface, onRoutine]);
  const automationName = automation?.name;
  const databaseName = schema?.database.name;
  useEffect(() => {
    if (automationName === undefined || databaseName === undefined) return;
    const previous = document.title;
    const name = automationName;
    const database = databaseName;
    document.title = t({ id: 'automations.title', message: `${name} – ${database}` });
    return () => {
      document.title = previous;
    };
  }, [automationName, databaseName, t]);
  // Features the database offers the palette whatever the person's level, so search always
  // finds the ones a level tidies out of the sidebar and menus.  Their words come from the registry.
  const editable = Boolean(session && roleAllows(session.role(), 'editSchema'));
  useFeatureCommands(
    'database.features',
    editable && table
      ? [
          { place: 'databaseSidebar:dashboards', run: () => createDashboard() },
          { place: 'addTable:import', run: () => setImporting(true) },
          // A synced table's records come from its source, so a file can't add to them.
          ...(table.source
            ? []
            : [
                {
                  place: 'tableMenu:importInto' as const,
                  target: { id: table.id, name: table.name },
                  run: () => setImportingInto(table.id),
                },
              ]),
          ...(sources.length ? [{ place: 'addTable:sync' as const, run: () => setSyncing(true) }] : []),
          { place: 'databaseMenu:webhooks', run: () => setWebhooksOpen(true) },
          {
            place: 'tableMenu:recordAccess',
            target: { id: table.id, name: table.name },
            run: () => setRecordAccess(table.id),
          },
        ]
      : [],
  );
  // What the database already uses, which keeps those entries in its menus at every level.  An
  // import that made the database leaves its report, so importing stays on offer too.
  const imported = airtableReport.available || Boolean(platformReport.platform);
  const holdings = useMemo(() => (schema ? databaseHoldings(schema, { imported }) : {}), [schema, imported]);
  function createDashboard() {
    if (!session || !schema) return;
    try {
      const dashboardId = newId('dashboard');
      const position = Math.max(-1, ...schema.dashboards.map((item) => item.position)) + 1;
      session.run([
        {
          kind: 'dashboard.create',
          dashboard: {
            id: dashboardId,
            name: t({ id: 'dashboards.untitled', message: 'Untitled dashboard' }),
            config: { tiles: [] },
          },
          position,
        },
      ]);
      void navigate({ to: dashboardHref(path.databaseId, dashboardId) });
    } catch (error) {
      reportError(error);
    }
  }
  if (!session || !schema) return <FramePlaceholder />;
  if (!table || !view) return <DatabaseUnavailable />;
  const canEdit = roleAllows(session.role(), 'editSchema');
  const go = (tableId: string, viewId?: string) => {
    void navigate({ to: databaseHref(path.databaseId, tableId, viewId) });
  };
  const goDashboard = (dashboardId: string) => {
    void navigate({ to: dashboardHref(path.databaseId, dashboardId) });
  };
  const execute = (action: () => void) => {
    try {
      action();
    } catch (error) {
      reportError(error);
    }
  };
  return (
    <HoldingsProvider holdings={holdings}>
      <RestrictedFields.Provider value={new Set(schema.access.hiddenFields.keys())}>
        <div
          className="rio-database-screen"
          onMouseOverCapture={preloadDatabaseDestination}
          onFocusCapture={preloadDatabaseDestination}
          data-database-theme={shownTheme?.id}
        >
          <SidebarNavigationProvider session={session} schema={schema}>
            {syncing && (
              <SyncWizard
                sources={sources}
                admin={sourceAdmin}
                session={session}
                onClose={() => setSyncing(false)}
                onCreated={go}
              />
            )}
            <AppSidebar>
              <Link to="/" className="rio-shell__nav-item" {...anchor('shell.home')} {...homeDrop}>
                <Trans id="database.home">Home</Trans>
              </Link>
              <div className="rio-db-sql-slot">
                <SqlLauncher databaseId={path.databaseId} people={[...schema.collaborators.values()]} />
              </div>
              {duplicateTableId && schema.tableById.has(duplicateTableId) && (
                <DuplicateActionDialog
                  kind="table"
                  id={duplicateTableId}
                  name={schema.tableById.get(duplicateTableId)!.name}
                  existingNames={schema.tables.map((table) => table.name)}
                  session={session}
                  onClose={() => setDuplicateTableId(null)}
                />
              )}
              <TableSidebar
                onDuplicate={canEdit ? setDuplicateTableId : undefined}
                onSync={() => setSyncing(true)}
                onTrash={() => setTrashOpen(true)}
                onFindLinks={setFindingLinks}
                onFindDuplicates={setFindingDuplicates}
                onRecordAccess={canEdit ? setRecordAccess : undefined}
                ruledTables={schema.access.ruledTables}
                onBookingPages={canEdit ? setBookingPages : undefined}
                tables={schema.tables}
                activeTableId={
                  path.namedFunctions || onDashboard || automation || onInterface || onRoutine
                    ? null
                    : table.id
                }
                hrefFor={(id) => databaseHref(path.databaseId, id)}
                onNavigate={(id) => go(id)}
                canEdit={canEdit}
                onRename={(tableId, name) =>
                  execute(() => {
                    session.run([{ kind: 'table.update', tableId, name }]);
                  })
                }
                onDelete={(tableId) =>
                  execute(() => {
                    const next = schema.tables.find((item) => item.id !== tableId);
                    session.run([{ kind: 'table.trash', tableId }]);
                    if (!onDashboard && table.id === tableId && next) go(next.id);
                  })
                }
                onMove={(tableId, toIndex) =>
                  execute(() => {
                    const ordered = schema.tables.filter((item) => item.id !== tableId);
                    const before = ordered[toIndex - 1]?.position;
                    const after = ordered[toIndex]?.position;
                    const position =
                      before === undefined
                        ? (after ?? 0) - 1
                        : after === undefined
                          ? before + 1
                          : (before + after) / 2;
                    session.run([{ kind: 'table.move', tableId, position }]);
                  })
                }
                onImport={() => setImporting(true)}
                onImportInto={roleAllows(session.role(), 'editRecords') ? setImportingInto : undefined}
                onCreate={() =>
                  execute(() => {
                    const tableId = newId('table');
                    const viewId = newId('view');
                    const count = schema.tables.length + 1;
                    session.run([
                      {
                        kind: 'table.create',
                        table: {
                          id: tableId,
                          name: t({ id: 'database.newTable', message: `Table ${count}` }),
                          fields: [
                            {
                              id: newId('field'),
                              name: t({ id: 'home.default.name', message: 'Name' }),
                              type: 'text',
                            },
                          ],
                          view: { id: viewId, name: t({ id: 'home.default.view', message: 'Grid' }) },
                        },
                      },
                    ]);
                    go(tableId, viewId);
                  })
                }
                dashboards={{
                  dashboards: schema.dashboards,
                  activeDashboardId: dashboard?.id ?? null,
                  hrefFor: (dashboardId) => dashboardHref(path.databaseId, dashboardId),
                  onNavigate: goDashboard,
                  onCreate: createDashboard,
                  onRename: (dashboardId, name) =>
                    execute(() => {
                      session.run([{ kind: 'dashboard.update', dashboardId, name }]);
                    }),
                  onDelete: (dashboardId) =>
                    execute(() => {
                      if (dashboard?.id === dashboardId) {
                        leaving.current = dashboardId;
                        go(table.id, view.id);
                      }
                      session.run([{ kind: 'dashboard.trash', dashboardId }]);
                    }),
                  onMove: (dashboardId, toIndex) =>
                    execute(() => {
                      const ordered = schema.dashboards.filter((item) => item.id !== dashboardId);
                      const before = ordered[toIndex - 1]?.position;
                      const after = ordered[toIndex]?.position;
                      const position =
                        before === undefined
                          ? (after ?? 0) - 1
                          : after === undefined
                            ? before + 1
                            : (before + after) / 2;
                      session.run([{ kind: 'dashboard.move', dashboardId, position }]);
                    }),
                }}
              >
                <Link
                  to={namedFunctionsHref(path.databaseId)}
                  className="rio-shell__nav-item"
                  aria-current={path.namedFunctions ? 'page' : undefined}
                  {...anchor('database.namedFunctions')}
                >
                  <Trans id="namedFunctions.title">Named functions</Trans>
                </Link>
                <InterfaceSidebar
                  session={session}
                  schema={schema}
                  activeInterfaceId={path.interfaceId ?? null}
                  tableId={table.id}
                />
                <AutomationSidebar
                  session={session}
                  schema={schema}
                  activeAutomationId={automation?.id ?? null}
                  tableId={table.id}
                />
                <ScriptSidebar
                  session={session}
                  schema={schema}
                  openScriptId={scriptOpen}
                  onOpen={(id) => {
                    setScriptRun(null);
                    setScriptOpen(id);
                  }}
                />
                <RoutineSidebar databaseId={path.databaseId} activeRoutineId={path.routineId ?? null} />
              </TableSidebar>
            </AppSidebar>
          </SidebarNavigationProvider>
          <DatabaseHeader
            database={schema.database}
            canManage={roleAllows(session.role(), 'manage')}
            onRename={(name) =>
              execute(() => {
                session.run([{ kind: 'database.update', name }]);
              })
            }
            saveIndicator={<SaveIndicator state={save} onRetry={() => session.retrySave?.()} />}
            presenceBar={<PresenceBar peers={peers} />}
            actions={
              <>
                <UndoHistoryButton session={session} />
                <ResponsiveToolbar
                  className="rio-db-header__actions"
                  label={t({ id: 'database.share', message: 'Share' })}
                  items={[
                    {
                      id: 'share',
                      variant: 'secondary' as const,
                      priority: 100,
                      icon: faShareNodes,
                      label: t({ id: 'database.share', message: 'Share' }),
                      buttonProps: anchor('database.share'),
                      onAction: () => setSharing('open'),
                    },
                  ]}
                />
                {canEdit ? (
                  <DatabaseSettingsMenu
                    onKnowledge={() =>
                      void navigate({
                        to: '/$databaseId/settings/knowledge',
                        params: { databaseId: path.databaseId },
                      })
                    }
                    onMemories={() =>
                      void navigate({
                        to: '/$databaseId/settings/memories',
                        params: { databaseId: path.databaseId },
                      })
                    }
                    onSimilar={() =>
                      void navigate({
                        to: '/$databaseId/settings/similar',
                        params: { databaseId: path.databaseId },
                      })
                    }
                    databaseId={path.databaseId}
                    onWebhooks={() => setWebhooksOpen(true)}
                    onSnapshots={() => setArchive('snapshots')}
                    onDuplicate={() => setArchive('duplicate')}
                    {...(isOrgAdmin(person) ? { onSaveTemplate: () => setArchive('template') } : {})}
                    {...(roleAllows(session.role(), 'manage')
                      ? { onTheme: () => setSettingsPanel('theme') }
                      : {})}
                    {...(airtableReport.available ? { onImportReport: airtableReport.open } : {})}
                    {...(platformReport.platform
                      ? {
                          platformReport: {
                            label: reportTitle(i18n, platformReport.platform),
                            open: platformReport.open,
                          },
                        }
                      : {})}
                  />
                ) : null}
              </>
            }
          />
          {path.namedFunctions ? (
            <NamedFunctionsScreen
              session={session}
              schema={schema}
              functionId={path.functionId}
              onOpen={(id) => {
                void navigate({ to: namedFunctionsHref(path.databaseId, id) });
              }}
            />
          ) : onDashboard ? (
            dashboard ? (
              <LazyBoundary>
                <DashboardScreen
                  key={dashboard.id}
                  session={session}
                  schema={schema}
                  dashboard={dashboard}
                  filters={dashboardFilters}
                  onFiltersChange={(filters) => setFiltersToken(dashboardFiltersToken(filters))}
                  drill={drill}
                  onDrillChange={setDrill}
                  onOpenView={(tableId, viewId, where) => {
                    void navigate({ to: databaseHref(path.databaseId, tableId, viewId), search: { where } });
                  }}
                />
              </LazyBoundary>
            ) : (
              <div className="rio-database-placeholder rio-database-placeholder--grid" />
            )
          ) : automation ? (
            <LazyBoundary>
              <AutomationScreen
                key={automation.id}
                session={session}
                schema={schema}
                automation={automation}
              />
            </LazyBoundary>
          ) : onRoutine ? (
            <LazyBoundary>
              <RoutineScreen
                key={path.routineId}
                routineId={path.routineId ?? ''}
                databaseName={schema.database.name}
              />
            </LazyBoundary>
          ) : onInterface ? (
            <LazyBoundary>
              <InterfaceScreen
                key={path.interfaceId}
                session={session}
                schema={schema}
                interfaceId={path.interfaceId ?? ''}
                pageId={path.pageId}
                fallbackHref={databaseHref(path.databaseId, table.id, view.id)}
              />
            </LazyBoundary>
          ) : (
            <DatabaseView
              key={view.id}
              session={session}
              schema={schema}
              table={table}
              view={view}
              recordId={recordId}
              recordPage={resolved?.recordPage}
              onMissing={fixedToast}
            />
          )}
          {importing ? (
            <ImportDialog
              databaseId={path.databaseId}
              session={session}
              onClose={() => setImporting(false)}
              onDone={(tableId) => {
                setImporting(false);
                go(tableId);
              }}
            />
          ) : null}
          {importingInto && (
            <ImportIntoTable
              session={session}
              tableId={importingInto}
              onClose={() => setImportingInto(null)}
            />
          )}
          {trashOpen && <TrashDialog session={session} onClose={() => setTrashOpen(false)} />}
          {findingLinks && (
            <JoinsDialog session={session} tableId={findingLinks} onClose={() => setFindingLinks(null)} />
          )}
          {airtableReport.dialog}
          {platformReport.dialog}
          {archive === 'snapshots' ? (
            <SnapshotsDialog
              databaseId={path.databaseId}
              databaseName={schema.database.name}
              people={schema.collaborators}
              onClose={() => setArchive(null)}
            />
          ) : archive === 'duplicate' ? (
            <DuplicateDialog
              databaseId={path.databaseId}
              databaseName={schema.database.name}
              onClose={() => setArchive(null)}
            />
          ) : archive === 'template' ? (
            <SaveTemplateDialog
              databaseId={path.databaseId}
              databaseName={schema.database.name}
              onClose={() => setArchive(null)}
            />
          ) : null}
          {settingsPanel === 'theme' && roleAllows(session.role(), 'manage') ? (
            <DatabaseThemeDialog
              session={session}
              theme={schema.database.theme ?? null}
              onClose={() => setSettingsPanel(null)}
            />
          ) : null}
          {webhooksOpen && (
            <WebhooksDialog
              databaseId={path.databaseId}
              tables={schema.tables}
              onClose={() => setWebhooksOpen(false)}
            />
          )}
          {findingDuplicates && (
            <DuplicatesPanel session={session} tableId={findingDuplicates} onClose={closeDuplicates} />
          )}
          {sharing === 'open' && (
            <ShareDialog
              databaseId={path.databaseId}
              databaseName={schema.database.name}
              canManage={session.role() === 'owner'}
              onClose={() => setSharing(null)}
            />
          )}
          {scriptOpen && schema.scriptById.get(scriptOpen) ? (
            <LazyBoundary
              size="dialog"
              onDismiss={() => {
                setScriptRun(null);
                setScriptOpen(null);
              }}
            >
              <ScriptPanel
                key={`${scriptOpen}:${scriptRun?.key ?? 0}`}
                autoRun={scriptRun?.id === scriptOpen}
                button={scriptRun?.id === scriptOpen ? scriptRun.button : undefined}
                session={session}
                schema={schema}
                script={schema.scriptById.get(scriptOpen)!}
                onClose={() => {
                  setScriptRun(null);
                  setScriptOpen(null);
                }}
              />
            </LazyBoundary>
          ) : null}
          {bookingPages && schema.tableById.get(bookingPages) ? (
            <LazyBoundary size="dialog" onDismiss={() => setBookingPages(null)}>
              <BookingPagesDialog
                tableId={bookingPages}
                tableName={schema.tableById.get(bookingPages)!.name}
                fields={schema.fields.get(bookingPages) ?? []}
                onClose={() => setBookingPages(null)}
              />
            </LazyBoundary>
          ) : null}
          {recordAccess && schema.tableById.get(recordAccess) && (
            <RecordAccessDialog
              session={session}
              table={schema.tableById.get(recordAccess)!}
              fields={schema.fields.get(recordAccess) ?? []}
              collaborators={schema.collaborators}
              onClose={() => setRecordAccess(null)}
            />
          )}
        </div>
      </RestrictedFields.Provider>
    </HoldingsProvider>
  );
}

function DatabaseView({
  recordPage = false,
  session,
  schema,
  table,
  view,
  recordId,
  onMissing,
}: {
  session: DatabaseSession;
  schema: SchemaState;
  table: TableMeta;
  view: ViewMeta;
  recordId?: string;
  recordPage?: boolean;
  onMissing(): void;
}) {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const router = useRouter();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const person = useSession();
  const savePreferences = useSavePreferences();
  const recordLayout = recordPage ? 'page' : (person?.preferences.recordLayout ?? 'card');
  const content = useRef<HTMLDivElement>(null);
  // A link to the records behind part of a dashboard chart narrows a grid for this person alone.
  const [whereToken, setWhere] = useLinkedPanel('where');
  const where = whereToken && view.type === 'grid' && decodeWhere(whereToken) ? whereToken : undefined;
  const rows = useViewRows(session, view.id, where, view.type === 'grid' ? 'structure' : 'all');
  /** Moving between records of the view keeps it narrowed, and nothing else in the address. */
  const keepWhere = useCallback(
    (previous: Record<string, unknown>) =>
      typeof previous.where === 'string' ? { where: previous.where } : {},
    [],
  );
  const peers = usePeers(session);
  const downloads = useViewDownload(where ? { viewId: view.id, where } : undefined);
  const fields = schema.fields.get(table.id) ?? [];
  const { config, change } = useViewConfig(session, view, fields);
  const [linkedField, linkField] = useLinkedPanel('fieldRules');
  const [calendarDay, onCalendarDay] = useLinkedPanel('calendarDay');
  const [dependencySource, onDependencySource] = useLinkedPanel('dependencies');
  const [fieldDialogDraft, setFieldDialogState] = useState<{
    fieldId: string | null;
    index?: number;
    initialType?: FieldType | 'ai';
  } | null>(null);
  const fieldDialog: typeof fieldDialogDraft = linkedField
    ? { ...(fieldDialogDraft?.fieldId === linkedField ? fieldDialogDraft : {}), fieldId: linkedField }
    : fieldDialogDraft?.fieldId === null
      ? fieldDialogDraft
      : null;
  const setFieldDialog = (value: typeof fieldDialog) => {
    setFieldDialogState(value);
    linkField(value?.fieldId ?? null);
  };
  const [colorPanel, setColorPanel] = useLinkedPanel('colors');
  const colorsOpen = colorPanel === 'open';
  const setColorsOpen = useCallback((open: boolean) => setColorPanel(open ? 'open' : null), [setColorPanel]);
  const [permissionsFor, setPermissionsFor] = useState<string | null>(null);
  const [sharingView, setSharingView] = useState<string | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [syncingOut, setSyncingOut] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Names of linked records and file details live in the session and fill in as pages arrive.
  const format = useMemo(
    () => ({
      locale: i18n.locale || 'en-US',
      timeZone,
      collaborators: schema.collaborators,
      linked: session.linked,
      attachments: session.attachments,
      fieldsById: schema.fieldById,
    }),
    [i18n.locale, timeZone, schema.collaborators, schema.fieldById, session],
  );
  const canEdit = roleAllows(session.role(), 'editSchema');
  const href = useCallback(
    (id?: string) =>
      id && recordPage
        ? recordPageHref(session.databaseId, table.id, view.id, id)
        : databaseHref(session.databaseId, table.id, view.id, id),
    [session.databaseId, table.id, view.id, recordPage],
  );
  const closeRecord = useCallback(() => {
    void navigate({ to: href(), search: keepWhere }).then(() => {
      requestAnimationFrame(() => content.current?.querySelector<HTMLElement>('.rio-grid textarea')?.focus());
    });
  }, [navigate, href, keepWhere]);
  const missingRecord = useCallback(() => {
    onMissing();
    void navigate({ to: href(), replace: true, search: keepWhere });
  }, [navigate, href, onMissing, keepWhere]);
  const definition = VIEW_DEFINITIONS[view.type];
  const colors = useViewColors(
    session,
    { ...view, config },
    fields,
    format,
    definition.usesColors === true,
    where,
  );
  const viewProps: ViewComponentProps = {
    calendarDay,
    onCalendarDay,
    dependencySource,
    onDependencySource,
    session,
    table,
    view: { ...view, config },
    fields,
    format,
    canEdit,
    onConfig: change,
    colors,
    onExpand: (id) => {
      void navigate({ to: href(id), search: keepWhere });
    },
    attachment: (id) => {
      const file = session.attachments.get(id);
      if (!file) session.ensureAttachments([id]);
      return file;
    },
  };
  const createView = (source?: ViewMeta, type: ViewType = source?.type ?? 'grid') => {
    const location = router.state.location;
    const id = newId('view');
    const kind = VIEW_DEFINITIONS[type];
    const name = source?.name ?? i18n._(kind.name);
    try {
      const action = session.run([
        {
          kind: 'view.create',
          view: {
            id,
            tableId: table.id,
            name: availableViewName(
              i18n,
              name,
              (schema.views.get(table.id) ?? []).map((item) => item.name),
              !!source,
            ),
            type,
            config: source ? source.config : kind.initialConfig(table, fields),
          },
        },
      ]);
      // Completion belongs to the location that started the request, even after a round trip.
      void action.done
        .then((result) => {
          if (!result.rejected && mounted.current && router.state.location === location)
            return navigate({ to: databaseHref(session.databaseId, table.id, id) });
        })
        .catch(reportError);
    } catch (error) {
      reportError(error);
    }
  };
  // Every kind of view and field, the view's conditional colors, and each field's permissions are
  // in the palette whatever the person's level.
  const live = readsSourceLive(table.source);
  const firstCopy =
    table.source &&
    !live &&
    table.source.sourceKind !== 'webhook' &&
    !table.source.status.lastSuccessAt &&
    table.source.status.state !== 'idle';
  const here = { id: table.id, name: table.name };
  useFeatureCommands(
    'database.view',
    canEdit
      ? [
          ...VIEW_TYPES.map((type) => ({
            place: `viewPicker:${type}` as const,
            target: here,
            run: () => createView(undefined, type),
          })),
          // A table a source fills live takes only the kinds of field the source can hold.
          ...FIELD_TYPES.filter((type) => !live || liveAllowsType(type)).map((type) => ({
            place: `fieldTypePicker:${type}` as const,
            target: here,
            run: () => setFieldDialog({ fieldId: null, initialType: type }),
          })),
          ...(live
            ? []
            : [
                {
                  place: 'fieldTypePicker:ai' as const,
                  target: here,
                  run: () => setFieldDialog({ fieldId: null, initialType: 'ai' }),
                },
              ]),
          ...fields.map((field) => ({
            place: 'fieldMenu:permissions' as const,
            target: { id: field.id, name: field.name },
            run: () => setPermissionsFor(field.id),
          })),
          ...(definition.usesToolbar && definition.usesColors
            ? [
                {
                  place: 'viewToolbar:colors' as const,
                  target: { id: view.id, name: view.name },
                  // The palette hands focus back as it closes, so the colors open a frame later.
                  run: () => requestAnimationFrame(() => setColorsOpen(true)),
                },
              ]
            : []),
        ]
      : [],
  );
  return (
    <>
      <div className="rio-database-controls" ref={toolbar} data-help-view={view.type}>
        <ViewTabs
          views={schema.views.get(table.id) ?? []}
          activeViewId={view.id}
          hrefFor={(id) => databaseHref(session.databaseId, table.id, id)}
          onNavigate={(id) => {
            void navigate({ to: databaseHref(session.databaseId, table.id, id) });
          }}
          canEdit={canEdit}
          onCreate={(type) => createView(undefined, type)}
          onDuplicate={(id) => createView(schema.viewById.get(id))}
          onMove={(viewId, toIndex) => {
            const ordered = (schema.views.get(table.id) ?? []).filter((item) => item.id !== viewId);
            const before = ordered[toIndex - 1]?.position;
            const after = ordered[toIndex]?.position;
            const position =
              before === undefined
                ? (after ?? 0) - 1
                : after === undefined
                  ? before + 1
                  : (before + after) / 2;
            session.run([{ kind: 'view.move', viewId, position }]);
          }}
          onRename={(viewId, name) => {
            session.run([{ kind: 'view.update', viewId, name }]);
          }}
          onDelete={(viewId) => {
            const next = schema.views.get(table.id)?.find((item) => item.id !== viewId);
            session.run([{ kind: 'view.trash', viewId }]);
            if (viewId === view.id && next)
              void navigate({ to: databaseHref(session.databaseId, table.id, next.id) });
          }}
          downloads={downloads}
          onShare={setSharingView}
          onPrint={setPrinting}
          onReports={setReporting}
          onSubscribe={setSubscribing}
        />
        <ToolbarSettings key={view.id} helpTopic={viewHelp[view.type]}>
          <ViewToolbar
            session={session}
            usesToolbar={definition.usesToolbar}
            groupable={view.type === 'grid'}
            config={config}
            fields={fields}
            primaryFieldId={table.primaryFieldId}
            collaborators={schema.collaborators}
            readOnly={!canEdit}
            colorable={definition.usesColors}
            downloads={{
              ...downloads.labels,
              busy: downloads.pending !== null,
              pending: downloads.pending?.viewId === view.id,
              onDownload: (format) => downloads.download(view.id, format),
              pdf: isPrintableViewType(view.type)
                ? { label: i18n._(printMenu), onAction: () => setPrinting(view.id) }
                : undefined,
              reports:
                view.type === 'form'
                  ? undefined
                  : { label: i18n._(reportsMenu), onAction: () => setReporting(view.id) },
              subscribe: isCalendarFeedViewType(view.type)
                ? { label: i18n._(subscribeMenu), onAction: () => setSubscribing(view.id) }
                : undefined,
            }}
            colorsOpen={colorsOpen}
            onColorsOpenChange={setColorsOpen}
            syncOut={
              canEdit && !['form', 'chart', 'pivot'].includes(view.type)
                ? {
                    label: i18n._(syncOutLabel),
                    onAction: () => setSyncingOut(view.id),
                    onPreload: () => SyncOutDialog.preload(),
                  }
                : undefined
            }
            onConfigChange={change}
          />
          {definition.Settings ? (
            <LazyBoundary size="controls">
              <definition.Settings {...viewProps} />
            </LazyBoundary>
          ) : null}
        </ToolbarSettings>
      </div>
      <TableDataControls session={session} table={table} />
      {table.source && <SyncStatus table={{ ...table, source: table.source }} session={session} />}
      {table.source && rows && (
        <LiveNotice
          rows={rows}
          fields={fields}
          viewType={readsSourceLive(table.source) ? view.type : undefined}
        />
      )}
      {where ? <NarrowedNotice onClear={() => setWhere(null)} /> : null}
      <div className="rio-record-workspace" ref={content}>
        {!recordPage && !firstCopy && (
          <div className="rio-record-workspace__view">
            {definition.View ? (
              <LazyBoundary>
                <definition.View {...viewProps} />
              </LazyBoundary>
            ) : rows ? (
              <GridView
                offerShortcuts
                session={session}
                rows={rows}
                table={table}
                view={{ ...view, config }}
                fields={fields}
                format={format}
                peers={peers}
                recordId={recordId}
                colors={colors}
                onCloseRecord={recordId && recordLayout === 'panel' ? closeRecord : undefined}
                onSelectRecord={
                  recordId && recordLayout === 'panel'
                    ? (id) => {
                        if (id !== recordId)
                          void navigate({ to: href(id), replace: true, search: keepWhere });
                      }
                    : undefined
                }
                onConfig={change}
                onExpand={(id, fieldId) => {
                  void navigate({
                    to: href(id),
                    search: (previous) => ({
                      ...keepWhere(previous),
                      ...(fieldId ? { cellField: fieldId } : {}),
                    }),
                  });
                }}
                onField={(fieldId, index) => setFieldDialog({ fieldId, index })}
                onPermissions={canEdit ? setPermissionsFor : undefined}
                onFilter={() => {
                  requestAnimationFrame(() =>
                    toolbar.current?.querySelector<HTMLButtonElement>('[data-anchor="view.filter"]')?.click(),
                  );
                }}
              />
            ) : (
              <div className="rio-database-placeholder rio-database-placeholder--grid" />
            )}
          </div>
        )}
        {recordId && rows && (
          <RecordOverlay
            viewId={view.id}
            layout={recordLayout}
            fullPageHref={recordPageHref(session.databaseId, table.id, view.id, recordId)}
            onLayoutChange={(layout) => {
              savePreferences.mutate({ recordLayout: layout }, { onError: reportError });
              if (recordPage)
                void navigate({ to: databaseHref(session.databaseId, table.id, view.id, recordId) });
            }}
            onOpenRecord={(tableId, id) => {
              void (async () => {
                let databaseId = session.databaseId;
                let linkedView = schema.views.get(tableId)?.[0];
                if (!linkedView) {
                  const databases = await api<DatabaseSummary[]>('/api/databases');
                  for (const database of databases) {
                    if (database.id === session.databaseId) continue;
                    const destination = await api<DatabaseSchema>(
                      `/api/databases/${database.id}/schema`,
                    ).catch((error: unknown) => {
                      if (error instanceof ApiError && (error.status === 403 || error.status === 404))
                        return null;
                      throw error;
                    });
                    linkedView = destination?.views.find((view) => view.tableId === tableId);
                    if (linkedView) {
                      databaseId = database.id;
                      break;
                    }
                  }
                }
                if (!linkedView)
                  throw new ApiError(404, {
                    code: 'not_found',
                    messageKey: 'errors.notFound',
                    userFault: true,
                  });
                await navigate({
                  to: recordPage
                    ? recordPageHref(databaseId, tableId, linkedView.id, id)
                    : databaseHref(databaseId, tableId, linkedView.id, id),
                });
              })().catch(reportError);
            }}
            session={session}
            rows={rows}
            recordId={recordId}
            tableId={table.id}
            fields={fields}
            primaryFieldId={table.primaryFieldId}
            format={format}
            colors={colors}
            onNavigate={(id) => {
              void navigate({ to: href(id), search: keepWhere });
            }}
            onClose={closeRecord}
            onMissing={missingRecord}
          />
        )}
      </div>
      {printing && schema.viewById.get(printing) && (
        <LazyBoundary size="dialog" onDismiss={() => setPrinting(null)}>
          <PrintViewDialog
            databaseName={schema.database.name}
            table={table}
            // The open view prints with its latest settings, even ones still being saved.
            view={printing === view.id ? { ...view, config } : schema.viewById.get(printing)!}
            fields={fields}
            format={format}
            onClose={() => setPrinting(null)}
          />
        </LazyBoundary>
      )}
      {downloads.choosing && schema.viewById.get(downloads.choosing.viewId) && (
        <OfficeDownloadDialog
          format={downloads.choosing.format}
          viewName={schema.viewById.get(downloads.choosing.viewId)!.name}
          onDownload={(choices) => {
            const choosing = downloads.choosing;
            if (choosing) downloads.start(choosing.viewId, choosing.format, choices);
          }}
          onCancel={downloads.cancel}
        />
      )}
      {reporting && schema.viewById.get(reporting) && (
        <LazyBoundary size="dialog" onDismiss={() => setReporting(null)}>
          <ReportsDialog
            viewId={reporting}
            viewName={schema.viewById.get(reporting)!.name}
            onClose={() => setReporting(null)}
          />
        </LazyBoundary>
      )}
      {syncingOut && schema.viewById.get(syncingOut) && (
        <LazyBoundary size="dialog" onDismiss={() => setSyncingOut(null)}>
          <SyncOutDialog
            viewId={syncingOut}
            viewName={schema.viewById.get(syncingOut)!.name}
            databaseId={session.databaseId}
            onClose={() => setSyncingOut(null)}
          />
        </LazyBoundary>
      )}
      {subscribing && schema.viewById.get(subscribing) && (
        <LazyBoundary size="dialog" onDismiss={() => setSubscribing(null)}>
          <CalendarFeedDialog
            viewId={subscribing}
            viewName={schema.viewById.get(subscribing)!.name}
            onClose={() => setSubscribing(null)}
          />
        </LazyBoundary>
      )}
      {sharingView && schema.viewById.get(sharingView) && (
        <ShareViewDialog
          view={schema.viewById.get(sharingView)!}
          fields={fields}
          primaryFieldId={table.primaryFieldId}
          onClose={() => setSharingView(null)}
        />
      )}
      {permissionsFor && schema.fieldById.get(permissionsFor) && (
        <FieldPermissionsDialog
          field={schema.fieldById.get(permissionsFor)!}
          collaborators={schema.collaborators}
          onClose={() => setPermissionsFor(null)}
        />
      )}
      {fieldDialog && (
        <FieldOverlay
          {...fieldDialog}
          session={session}
          tableId={table.id}
          viewId={view.id}
          primaryFieldId={table.primaryFieldId}
          fields={fields}
          format={format}
          onClose={() => setFieldDialog(null)}
        />
      )}
    </>
  );
}

function useLinkedPanel(
  key:
    | 'import'
    | 'share'
    | 'fieldRules'
    | 'recordLocks'
    | 'duplicates'
    | 'script'
    | 'calendarDay'
    | 'dependencies'
    | 'settings'
    | 'drill'
    | 'dashboardFilters'
    | 'colors'
    | 'where',
) {
  const navigate = useNavigate();
  const value = useSearch({
    strict: false,
    select: (search: Record<string, unknown>) =>
      typeof search[key] === 'string' ? (search[key] as string) : null,
  });
  const change = useCallback(
    (next: string | null) => {
      void navigate({
        to: '.',
        replace: true,
        search: (previous: Record<string, unknown>) => ({ ...previous, [key]: next ?? undefined }),
      });
    },
    [key, navigate],
  );
  return [value, change] as const;
}
