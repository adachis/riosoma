import { onPublicDomain, publicPagePath } from './public-domain';
import { IMPORT_PLATFORMS, isWhereToken, safeSignInNext, type ImportPlatform } from '@riosoma/contracts';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  notFound,
  redirect,
} from '@tanstack/react-router';
import { api } from './api';
import { loadFeatureCatalog } from './i18n';
import { LoadingState, lazyRouteComponent } from './shell/lazy';

function catalogRoute<T>(load: () => Promise<T>): () => Promise<T> {
  return () => Promise.all([load(), loadFeatureCatalog()]).then(([module]) => module);
}
import { AppShell } from './shell/AppShell';
import { settingsReturn } from './shell/settings-return';
import { HomeScreen } from './screens/HomeScreen';
import { homeQuery } from './screens/home/folders';
import { BootError } from './shell/BootError';
import { sessionQuery, setupStatusQuery } from './session';
import { parseDrill } from './screens/database/dashboards/drill';

export interface RouterContext {
  queryClient: QueryClient;
}

/** Only same-origin paths may be used as a return address after signing in. */
export const safeNext = safeSignInNext;

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  errorComponent: BootError,
  beforeLoad: async ({ context, location }) => {
    if (onPublicDomain()) {
      if (!publicPagePath(location.pathname)) throw notFound();
      return;
    }
    const status = await context.queryClient.ensureQueryData(setupStatusQuery);
    const inSetup = location.pathname === '/setup';
    if (status.stage !== 'ready' && !inSetup) throw redirect({ to: '/setup' });
    if (status.stage === 'ready' && inSetup) throw redirect({ to: '/' });
  },
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'setup',
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/setup/SetupScreen')),
    'SetupScreen',
  ),
});

/** A single sign-on failure sent back to the sign-in page, as a message key and nothing more. */
const SSO_ERROR = /^sso\.[A-Za-z]{1,40}$/;

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sign-in',
  validateSearch: (search: Record<string, unknown>): { next?: string; error?: string } => ({
    ...(typeof search.next === 'string' ? { next: safeNext(search.next) } : {}),
    ...(typeof search.error === 'string' && SSO_ERROR.test(search.error) ? { error: search.error } : {}),
  }),
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/SignInScreen')),
    'SignInScreen',
  ),
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sign-in/forgot-password',
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/PasswordResetScreen')),
    'ForgotPasswordScreen',
  ),
});
const passwordResetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sign-in/reset',
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/PasswordResetScreen')),
    'PasswordResetScreen',
  ),
});

const signInLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sign-in/link',
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    ...(typeof search.next === 'string' ? { next: safeNext(search.next) } : {}),
  }),
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/SignInLinkScreen')),
    'SignInLinkScreen',
  ),
});

const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'join',
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/join/JoinScreen')),
    'JoinScreen',
  ),
});

/** A form shared by link: anyone may answer it, so it needs no session. */
const publicFormRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'f/$formId',
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/public-form/PublicFormScreen')),
    'PublicFormScreen',
  ),
});

const publicFormEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'f/$formId/edit',
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/public-form/PublicFormScreen')),
    'PublicFormEditScreen',
  ),
});

/** A view shared by link: anyone may read it, so it needs no session. */
const sharedViewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'v/$linkId',
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/shared-view/SharedViewScreen')),
    'SharedViewScreen',
  ),
});

/** A booking page: anyone may book a time on it, so it needs no session. */
const bookingPageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'b/$pageId',
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/booking/BookingPageScreen')),
    'BookingPageScreen',
  ),
});

/** The cancel link in a booking's confirmation email: it cancels that one booking, with no session. */
const paymentConfirmRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'payments/confirm',
  component: lazyRouteComponent(
    catalogRoute(() => import('./features/payments/PaymentConfirmScreen')),
    'PaymentConfirmScreen',
  ),
});

const bookingCancelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'bookings/cancel',
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/booking/BookingCancelScreen')),
    'BookingCancelScreen',
  ),
});

const signingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'signatures',
  component: lazyRouteComponent(
    catalogRoute(() => import('./features/signatures/SigningScreen')),
    'SigningScreen',
  ),
});

/** The link at the foot of a scheduled report's email: it stops one person getting it, with no session. */
const reportUnsubscribeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'reports/unsubscribe',
  component: lazyRouteComponent(
    catalogRoute(() => import('./features/reports/UnsubscribeScreen')),
    'UnsubscribeScreen',
  ),
});

/** Where the small window that connects a cloud drive account lands, to report back and close. */
const connectedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'connected/$provider',
  component: lazyRouteComponent(
    catalogRoute(() => import('./files/pickers/ConnectedScreen')),
    'ConnectedRoute',
  ),
});

/** Everything past this point needs a signed-in person. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppShell,
  // Help opens over any page and keeps its place in the address: ?help= for the index, or a topic.
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    help?: string;
    helpSection?: string;
    helpWindow?: 1;
    rioPreview?: string;
    rioPreviewTarget?: string;
    share?: string;
    shortcuts?: '1';
    appearance?: '1';
  } => ({
    ...(typeof search.share === 'string' && /^[0-9A-Za-z_-]{1,100}$/.test(search.share)
      ? { share: search.share }
      : {}),
    ...(search.shortcuts === '1' || search.shortcuts === 1 ? { shortcuts: '1' as const } : {}),
    ...(search.appearance === '1' || search.appearance === 1 ? { appearance: '1' as const } : {}),
    ...(typeof search.help === 'string' && /^[a-z0-9.-]{0,80}$/.test(search.help)
      ? { help: search.help }
      : {}),
    ...(typeof search.helpSection === 'string' && /^[a-z0-9-]{1,100}$/.test(search.helpSection)
      ? { helpSection: search.helpSection }
      : {}),
    ...(search.helpWindow === '1' || search.helpWindow === 1 ? { helpWindow: 1 as const } : {}),
    ...(typeof search.rioPreview === 'string' && /^[0-9a-f-]{36}$/.test(search.rioPreview)
      ? { rioPreview: search.rioPreview }
      : {}),
    ...(typeof search.rioPreviewTarget === 'string' && /^[0-9A-Za-z_/-]{1,100}$/.test(search.rioPreviewTarget)
      ? { rioPreviewTarget: search.rioPreviewTarget }
      : {}),
  }),
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session) throw redirect({ to: '/sign-in', search: { next: location.href } });
    if (session.demo && /^\/(?:settings|admin)(?:\/|$)/.test(location.pathname)) throw redirect({ to: '/' });
    if (session.demo && (location.pathname === '/' || location.pathname === '/home')) {
      const files = await context.queryClient.ensureQueryData(homeQuery);
      const ownsFiles =
        files.databases.some((database) => database.owned || !database.shared) ||
        files.folders.some(
          (folder) => !folder.trashed && (folder.ownerId === session.user.id || !folder.shared),
        ) ||
        files.shortcuts?.some((shortcut) => shortcut.owned && !shortcut.trashed);
      const hasSharedFiles =
        files.databases.some((database) => database.shared) ||
        files.folders.some((folder) => folder.shared && !folder.trashed);
      if (!ownsFiles && hasSharedFiles)
        throw redirect({
          to: '/home/$section',
          params: { section: 'shared' },
          search: location.search,
          replace: true,
        });
    }
    return { session };
  },
});

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  // The palette sends its home-screen commands through the address: which dialog to open, and
  // whether to open the trash.  Home reads them once and clears them again.
  validateSearch: (
    search: Record<string, unknown>,
  ): { new?: 'database' | 'import' | 'photo' | 'airtable' | ImportPlatform; trash?: '1' } => ({
    ...(search.new === 'database' ||
    search.new === 'import' ||
    search.new === 'photo' ||
    search.new === 'airtable' ||
    (IMPORT_PLATFORMS as readonly unknown[]).includes(search.new)
      ? { new: search.new as 'database' | 'import' | 'photo' | 'airtable' | ImportPlatform }
      : {}),
    ...(search.trash === '1' || search.trash === 1 ? { trash: '1' } : {}),
  }),
  component: HomeScreen,
});

const homeTagRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/home/tags/$tagId',
  component: HomeScreen,
});

const homeIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/home',
  validateSearch: homeRoute.options.validateSearch,
  component: HomeScreen,
});

const homeFolderRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/home/folders/$folderId',
  component: HomeScreen,
});
const homeSectionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/home/$section',
  validateSearch: homeRoute.options.validateSearch,
  component: HomeScreen,
});

/** An installed app may receive this navigation from its offline fallback before the server does. */
const oauthAuthorizeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'oauth/authorize',
  beforeLoad: async ({ location }) => {
    const result = await api<{ request: string }>(`/api/oauth/authorize${location.searchStr}`);
    throw redirect({ to: '/oauth/consent', search: { request: result.request }, replace: true });
  },
});

const oauthConsentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'oauth/consent',
  validateSearch: (search: Record<string, unknown>): { request: string } => ({
    request:
      typeof search.request === 'string' && /^[A-Za-z0-9_-]{43}$/.test(search.request) ? search.request : '',
  }),
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/oauth/OAuthConsentScreen')),
    'OAuthConsentScreen',
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'settings/$section',
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    returnTo?: string;
    tab?: string;
    server?: string;
    source?: string;
    kind?: string;
    database?: string;
    library?: string;
    document?: string;
    unit?: string;
    query?: string;
  } => ({
    ...(typeof search.returnTo === 'string' ? { returnTo: settingsReturn(search.returnTo) } : {}),
    ...(search.tab === 'tools' ? { tab: 'tools' } : {}),
    ...(typeof search.server === 'string' ? { server: search.server } : {}),
    ...(typeof search.source === 'string' && /^(new|src[0-9A-Za-z]{14})$/.test(search.source)
      ? { source: search.source }
      : {}),
    ...(typeof search.kind === 'string' && /^[a-z-]{1,40}$/.test(search.kind) ? { kind: search.kind } : {}),
    ...(typeof search.database === 'string' ? { database: search.database } : {}),
    ...(typeof search.library === 'string' ? { library: search.library } : {}),
    ...(typeof search.document === 'string' ? { document: search.document } : {}),
    ...(typeof search.unit === 'string' ? { unit: search.unit } : {}),
    ...(typeof search.query === 'string' ? { query: search.query.slice(0, 2000) } : {}),
  }),
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/settings/SettingsScreen')),
    'SettingsScreen',
  ),
});

const personalSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'settings/$section/$',
  validateSearch: settingsRoute.options.validateSearch,
  component: settingsRoute.options.component,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'settings',
  validateSearch: settingsRoute.options.validateSearch,
  component: settingsRoute.options.component,
});

const adminSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'admin/$',
  validateSearch: settingsRoute.options.validateSearch,
  component: settingsRoute.options.component,
});

const galleryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'gallery',
  validateSearch: (search: Record<string, unknown>): { theme?: string; scheme?: string } => ({
    ...(typeof search.theme === 'string' ? { theme: search.theme } : {}),
    ...(typeof search.scheme === 'string' ? { scheme: search.scheme } : {}),
  }),
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/GalleryScreen')),
    'GalleryScreen',
  ),
});

const knowledgeReaderRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'knowledge/$libraryId',
  validateSearch: (search: Record<string, unknown>): { document?: string; query?: string } => ({
    document: typeof search.document === 'string' ? search.document : undefined,
    query: typeof search.query === 'string' ? search.query.slice(0, 2000) : undefined,
  }),
  component: lazyRouteComponent(
    catalogRoute(() => import('./features/ai/Libraries')),
    'LibraryReader',
  ),
});
const databaseKnowledgeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '$databaseId/settings/knowledge',
  validateSearch: (
    search: Record<string, unknown>,
  ): { library?: string; document?: string; query?: string } => ({
    library: typeof search.library === 'string' ? search.library : undefined,
    document: typeof search.document === 'string' ? search.document : undefined,
    query: typeof search.query === 'string' ? search.query.slice(0, 2000) : undefined,
  }),
  component: lazyRouteComponent(
    catalogRoute(() => import('./features/ai/Libraries')),
    'DatabaseLibrary',
  ),
});
const databaseMemoriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '$databaseId/settings/memories',
  component: lazyRouteComponent(
    catalogRoute(() => import('./features/ai/Knowledge')),
    'DatabaseMemories',
  ),
});
const similarRecordsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '$databaseId/settings/similar',
  validateSearch: (search: Record<string, unknown>): { table?: string; query?: string } => ({
    ...(typeof search.table === 'string' ? { table: search.table } : {}),
    ...(typeof search.query === 'string' ? { query: search.query.slice(0, 2000) } : {}),
  }),
  component: lazyRouteComponent(
    catalogRoute(() => import('./features/ai/Knowledge')),
    'SimilarRecords',
  ),
});
const databaseRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '$databaseId',
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    cellField?: string;
    fieldRules?: string;
    fileSource?: string;
    fileRecord?: string;
    filePicker?: 'url' | 'images' | 'scan';
    calendarDay?: string;
    dependencies?: string;
    recordLocks?: string;
    duplicates?: string;
    import?: string;
    dataPanel?: string;
    syncCursor?: string;
    settings?: string;
    where?: string;
  } => ({
    ...(typeof search.calendarDay === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(search.calendarDay) &&
    Number.isFinite(Date.parse(search.calendarDay))
      ? { calendarDay: search.calendarDay }
      : {}),
    ...(typeof search.dependencies === 'string' && /^rec[0-9A-Za-z]{14}$/.test(search.dependencies)
      ? { dependencies: search.dependencies }
      : {}),
    ...(typeof search.cellField === 'string' && /^fld[0-9A-Za-z]{14}$/.test(search.cellField)
      ? { cellField: search.cellField }
      : {}),
    ...(search.colors === 'open' ? { colors: 'open' } : {}),
    ...(typeof search.fieldRules === 'string' ? { fieldRules: search.fieldRules } : {}),
    ...(typeof search.fileSource === 'string' && /^fld[0-9A-Za-z]{14}$/.test(search.fileSource)
      ? { fileSource: search.fileSource }
      : {}),
    ...(typeof search.fileRecord === 'string' && /^rec[0-9A-Za-z]{14}$/.test(search.fileRecord)
      ? { fileRecord: search.fileRecord }
      : {}),
    ...(search.filePicker === 'url' || search.filePicker === 'images' || search.filePicker === 'scan'
      ? { filePicker: search.filePicker }
      : {}),
    ...(typeof search.recordLocks === 'string' ? { recordLocks: search.recordLocks } : {}),
    ...(typeof search.import === 'string' && /^(new|tbl[0-9A-Za-z]{14})$/.test(search.import)
      ? { import: search.import }
      : {}),
    ...(typeof search.duplicates === 'string' ? { duplicates: search.duplicates } : {}),
    ...(typeof search.dataPanel === 'string' &&
    ['join', 'mapping', 'overrides', 'sync-history'].includes(search.dataPanel)
      ? { dataPanel: search.dataPanel }
      : {}),
    ...(typeof search.syncCursor === 'string' ? { syncCursor: search.syncCursor.slice(0, 1000) } : {}),
    // The database's own settings that open over it, such as its theme
    ...(search.settings === 'theme' ? { settings: search.settings } : {}),
    // A filter a link adds to a grid view for this person alone, such as a dashboard chart's part.
    ...(typeof search.where === 'string' && isWhereToken(search.where) ? { where: search.where } : {}),
  }),
  component: lazyRouteComponent(
    catalogRoute(() => import('./screens/database/DatabaseScreen')),
    'DatabaseScreen',
  ),
  errorComponent: lazyRouteComponent(
    catalogRoute(() => import('./screens/database/DatabaseScreen')),
    'DatabaseUnavailable',
  ),
});
const tableRoute = createRoute({ getParentRoute: () => databaseRoute, path: '$tableId' });
const viewRoute = createRoute({ getParentRoute: () => tableRoute, path: '$viewId' });
const recordRoute = createRoute({ getParentRoute: () => viewRoute, path: '$recordId' });
const recordPageRoute = createRoute({ getParentRoute: () => recordRoute, path: 'page' });
const recordSuffixRoute = createRoute({ getParentRoute: () => recordRoute, path: '$recordSuffix/$' });
// A static segment outranks a table ID, and no table ID can read "dashboards".
// `?drill=` names the part of a chart whose records are open over the dashboard.
const dashboardRoute = createRoute({
  getParentRoute: () => databaseRoute,
  path: 'dashboards/$dashboardId',
  validateSearch: (search: Record<string, unknown>): { drill?: string } =>
    typeof search.drill === 'string' && parseDrill(search.drill) ? { drill: search.drill } : {},
});
// The static segment outranks a table ID, so /<databaseId>/automations/<automationId> opens the editor.
const namedFunctionsRoute = createRoute({ getParentRoute: () => databaseRoute, path: 'named-functions' });
const namedFunctionRoute = createRoute({ getParentRoute: () => namedFunctionsRoute, path: '$functionId' });
const automationRoute = createRoute({
  getParentRoute: () => databaseRoute,
  path: 'automations/$automationId',
});
// The static segment outranks a table ID, so /<databaseId>/routines/<routineId> opens a routine.
const routineRoute = createRoute({ getParentRoute: () => databaseRoute, path: 'routines/$routineId' });
// /<databaseId>/interfaces/<interfaceId> opens an interface's first page, and a page ID opens that one,
// with the record picked in one of its records blocks in the search.
const interfaceRoute = createRoute({ getParentRoute: () => databaseRoute, path: 'interfaces/$interfaceId' });
const interfacePageRoute = createRoute({
  getParentRoute: () => interfaceRoute,
  path: '$pageId',
  validateSearch: (
    search: Record<string, unknown>,
  ): { block?: string; record?: string; editor?: string; detail?: string } => ({
    ...(search.detail === 'record' ? { detail: 'record' } : {}),
    ...(typeof search.editor === 'string' ? { editor: search.editor } : {}),
    ...(typeof search.block === 'string' ? { block: search.block } : {}),
    ...(typeof search.record === 'string' ? { record: search.record } : {}),
  }),
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  signInRoute,
  signInLinkRoute,
  forgotPasswordRoute,
  passwordResetRoute,
  joinRoute,
  publicFormRoute,
  publicFormEditRoute,
  sharedViewRoute,
  reportUnsubscribeRoute,
  bookingPageRoute,
  bookingCancelRoute,
  paymentConfirmRoute,
  signingRoute,
  connectedRoute,
  oauthAuthorizeRoute,
  appRoute.addChildren([
    homeRoute,
    homeIndexRoute,
    homeFolderRoute,
    homeTagRoute,
    homeSectionRoute,
    settingsRoute,
    personalSettingsRoute,
    settingsIndexRoute,
    adminSettingsRoute,
    databaseMemoriesRoute,
    similarRecordsRoute,
    databaseKnowledgeRoute,
    knowledgeReaderRoute,
    oauthConsentRoute,
    galleryRoute,
    databaseRoute.addChildren([
      automationRoute,
      namedFunctionsRoute.addChildren([namedFunctionRoute]),
      routineRoute,
      tableRoute.addChildren([
        viewRoute.addChildren([recordRoute.addChildren([recordPageRoute, recordSuffixRoute])]),
      ]),
      dashboardRoute,
      interfaceRoute.addChildren([interfacePageRoute]),
    ]),
  ]),
]);

export function makeRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
    defaultPendingComponent: LoadingState,
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
