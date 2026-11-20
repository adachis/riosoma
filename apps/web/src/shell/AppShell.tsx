import { recoverImport } from '../asset-recovery';
import { AppLogo } from '../brand/OrganizationLogo';
import { RiosomaLogo } from '../brand/RiosomaLogo';
import { appConfigQuery } from '../app-config';
import { PersonalMenu } from './PersonalMenu';
import { CompactHeaderStatus } from './CompactHeaderStatus';
import { ShellFooter } from './ShellFooter';
import { settingsReturn } from './settings-return';
import { NavLinks } from './NavLinks';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate, useRouteContext, useSearch } from '@tanstack/react-router';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { faBars, faCommentDots, faXmark } from '@fortawesome/free-solid-svg-icons';

import { RioLauncher } from '../features/rio/RioLauncher';
import { LazyBoundary, lazyFeature } from './lazy';
import { Button, toast, PersonDirectory } from '@riosoma/ui';
import type { Member, PersonIdentity } from '@riosoma/contracts';
import { browserClock, browserWebSocket, clientId } from '../data/deps';
import { sharedRealtime } from '../data/realtime';
import { api, ApiError, currentCsrfToken, setCsrfToken } from '../api';
import { activateLocale, matchLocale } from '../i18n';
import { useServerMessage } from '../messages/shellMessage';

import { PaletteButton } from '../palette/PaletteButton';
import { PaletteSourcesProvider } from '../palette/sources';
import { LevelProvider } from '../levels/context';
import { rememberLocale } from '../preferences';

import { DemoHost } from '../demos/DemoHost';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { UpdateNotice } from '../features/updates/UpdateNotice';

import { CelebrationLayer } from '../features/celebrations/CelebrationLayer';
import {
  appliedSettings,
  canManagePeople,
  canUseTokens,
  RetainedSession,
  sameSessionIdentity,
  sessionQuery,
} from '../session';
import { canOpenUnits } from '../screens/settings/units/access';
import { useShortcut } from '../shortcuts/useShortcut';
import { useAppliedTheme } from './useAppliedTheme';
import { useMediaQuery } from './useMediaQuery';
import { SidebarResizer, useSidebarWidth } from './SidebarResizer';
import './AppShell.css';
import { SettingsDraftFooter } from '../screens/settings/SettingsDraftFooter';
import { useSettingsLeaveGuard } from '../screens/settings/SettingsDraftContext';
import type { HelpContext, HelpTopic } from '../docs/context';
import { HELP_REQUEST, type HelpRequest } from '../docs/help-request';

const SettingsDraftProvider = lazyFeature(() =>
  import('../screens/settings/SettingsDraftProvider').then((module) => ({
    default: module.SettingsDraftProvider,
  })),
);

const QuickAppearance = lazyFeature(() =>
  import('./QuickAppearance').then((module) => ({ default: module.QuickAppearance })),
);

const ShortcutHelp = lazyFeature(() =>
  import('../shortcuts/ShortcutHelp').then((module) => ({ default: module.ShortcutHelp })),
);

const ShellDrawer = lazyFeature(() =>
  import('./ShellDrawer').then((module) => ({ default: module.ShellDrawer })),
);

const PlanPreview = lazyFeature(() =>
  import('../features/rio/PlanPreview').then((module) => ({ default: module.PlanPreview })),
);

const DocsPanel = lazyFeature(() =>
  import('../docs/DocsPanel').then((module) => ({ default: module.DocsPanel })),
);

const CommandPalette = lazyFeature(() =>
  import('../palette/CommandPalette').then((module) => ({ default: module.CommandPalette })),
);

const FeedbackDialog = lazyFeature(() =>
  import('../features/feedback/FeedbackDialog').then((module) => ({ default: module.FeedbackDialog })),
);

const ReauthenticationDialog = lazyFeature(() =>
  import('./ReauthenticationDialog').then((module) => ({ default: module.ReauthenticationDialog })),
);

/** Where `AppSidebar` content goes.  It's exported so a screen can be tested with its sidebar. */
export const SidebarSlot = createContext<HTMLElement | null>(null);

/** Routes can supply navigation without coupling the shell to their data. */
export function AppSidebar({ children }: { children: ReactNode }) {
  const target = useContext(SidebarSlot);
  return target ? createPortal(children, target) : null;
}

/**
 * The frame around every signed-in page: a fixed header, a resizable sidebar, the main area, and
 * a fixed footer.  Phone settings reserve room for touch targets.  On phones the sidebar
 * becomes a menu that slides in from the start edge.  The AI button that opens Rio is in the header
 * at every width.
 */
export function AppShell() {
  const settings = useLocation({
    select: (location) => location.pathname.startsWith('/settings') || location.pathname.startsWith('/admin'),
  });
  return settings ? (
    <LazyBoundary size="page">
      <SettingsDraftProvider>
        <Shell />
      </SettingsDraftProvider>
    </LazyBoundary>
  ) : (
    <Shell />
  );
}

function Shell() {
  const { t } = useLingui();
  // The route context holds the session as it was on load; the query holds the live one, which
  // changes when the person saves a preference.
  const { session: loaded } = useRouteContext({ from: '/app' });
  const live = useQuery(sessionQuery);
  const [deactivated, setDeactivated] = useState(false);
  const userId = live.data?.user.id;
  const csrf = live.data?.csrfToken;
  useEffect(() => {
    if (!userId || !csrf || live.data?.demo) return;
    // Account notices must reach every signed-in screen, including pages without a database.
    return sharedRealtime(browserWebSocket, browserClock, clientId(), userId, currentCsrfToken).add({
      databaseId: '',
      seq: () => 0,
      message: () => undefined,
      connection: () => undefined,
    });
  }, [userId, csrf, live.data?.demo]);
  const people = useQuery({
    queryKey: ['org', 'members'],
    queryFn: () => api<Member[]>('/api/org/members'),
    enabled: Boolean(live.data && !live.data.demo),
  });
  const [rememberedSession, rememberSession] = useState(loaded);
  const identityChanged = Boolean(live.data && !sameSessionIdentity(rememberedSession, live.data));
  if (live.data && !identityChanged && live.data !== rememberedSession) rememberSession(live.data);
  const session = identityChanged ? rememberedSession : (live.data ?? rememberedSession);
  const expiredSession = useRef(false);
  useEffect(() => {
    if (identityChanged) window.location.reload();
    else if (live.data === null) expiredSession.current = true;
    else if (live.data && expiredSession.current) {
      expiredSession.current = false;
      const identity = live.data;
      void import('../data/session')
        .then(({ recoverDatabaseSessions }) => recoverDatabaseSessions(identity))
        .catch(() => undefined);
    }
  }, [identityChanged, live.data]);
  const platform = useQuery({ ...appConfigQuery, enabled: Boolean(session.org.settings.logo) });
  const version = platform.data?.version;
  const { i18n } = useLingui();
  const message = useServerMessage();
  const [signingOut, setSigningOut] = useState(false);
  const [width, setWidth] = useSidebarWidth();
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useLocation({ select: (location) => location.pathname });
  const [menuPath, setMenuPath] = useState(pathname);
  // A table created in a dialog navigates without clicking a sidebar link.
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setMenuOpen(false);
  }
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [sidebarTarget, setSidebarTarget] = useState<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      for (const key of ['session', 'org', 'notifications'])
        void queryClient.invalidateQueries({ queryKey: [key] });
    };
    const changed = (event: Event) => {
      const person = (event as CustomEvent<PersonIdentity>).detail;
      queryClient.setQueryData<Member[]>(['org', 'members'], (members) =>
        members?.map((member) => (member.id === person.id ? { ...member, ...person } : member)),
      );
      void queryClient.invalidateQueries({ queryKey: ['me', 'profile'] });
    };
    const ended = () => {
      setDeactivated(true);
      setCsrfToken(null);
      queryClient.setQueryData(sessionQuery.queryKey, null);
    };
    window.addEventListener('personChanged', changed);
    window.addEventListener('accountDeactivated', ended);
    window.addEventListener('organizationChanged', refresh);
    return () => {
      window.removeEventListener('personChanged', changed);
      window.removeEventListener('accountDeactivated', ended);
      window.removeEventListener('organizationChanged', refresh);
    };
  }, [queryClient]);
  const navigate = useNavigate();
  const requestLeave = useSettingsLeaveGuard();
  useAppliedTheme(session);
  // Feedback opens from anywhere too, over whatever is on the page, so it can be pictured.
  useShortcut('feedback.open', () => {
    setPaletteOpen(false);
    setFeedbackOpen(true);
  });

  // Recover in place so every form keeps its local state while sign-in completes.
  const signedOut = live.data === null;

  // A language the person chose wins over their unit's or organization's default, which wins over
  // the account's own, and any of them over whatever this browser used last.
  const preferredLocale = matchLocale([
    new URLSearchParams(window.location.search).get('lang') ??
      session.preferences.locale ??
      appliedSettings(session)?.defaultLocale ??
      session.user.locale,
  ]);
  useEffect(() => {
    if (preferredLocale && preferredLocale !== i18n.locale) {
      void activateLocale(preferredLocale).then(rememberLocale);
    }
  }, [preferredLocale, i18n.locale]);
  const phone = useMediaQuery('(max-width: 767px)');
  const compactHeader = useMediaQuery('(max-width: 1023px)');
  const location = useLocation();
  const { help, helpSection, helpWindow, rioPreview, shortcuts, appearance } = useSearch({ from: '/app' });
  const inSettings = /^\/(settings|admin)(\/|$)/.test(location.pathname);
  const returnTo = settingsReturn(location.search.returnTo);
  const setOverlay = (key: 'shortcuts' | 'appearance', open: boolean) => {
    void navigate({
      to: '.',
      search: (previous: Record<string, unknown>) => {
        const next = { ...previous };
        if (open) next[key] = '1';
        else delete next[key];
        return next;
      },
    }).then(() => {
      if (!open)
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>('[data-personal-menu-trigger]')?.focus(),
        );
    });
  };
  const openSettings = () => {
    void navigate({ to: '/settings', search: { returnTo: inSettings ? returnTo : location.href } });
  };
  const [alsoHelp, setAlsoHelp] = useState<HelpTopic[]>([]);
  const helpReturn = useRef<HTMLElement | null>(null);
  const questionControl = useRef<HTMLElement | null>(null);
  const paletteContext = useRef<HelpContext | null>(null);
  const demoWindow = useRef(false);
  const [helpHost, setHelpHost] = useState<HTMLElement | null>(null);
  const helpAddress = `${help ?? '-'}:${helpSection ?? ''}:${helpWindow ?? ''}`;
  const [retainedWindow, setRetainedWindow] = useState<{ observed: string; topic: HelpTopic | null }>({
    observed: helpAddress,
    topic: helpWindow && help !== undefined ? { id: help, section: helpSection } : null,
  });
  if (retainedWindow.observed !== helpAddress) {
    setRetainedWindow({
      observed: helpAddress,
      topic:
        helpWindow && help !== undefined
          ? { id: help, section: helpSection }
          : help !== undefined
            ? null
            : retainedWindow.topic,
    });
  }
  const activeHelp = help ?? retainedWindow.topic?.id;
  const activeHelpSection = help !== undefined ? helpSection : retainedWindow.topic?.section;
  const windowOpen = Boolean(helpWindow || retainedWindow.topic);
  const helpOpen = activeHelp !== undefined;
  const helpRequest = useRef(0);
  const setHelp = (
    topic: string | undefined,
    restoreFocus = true,
    section?: string,
    floating = windowOpen,
  ) => {
    helpRequest.current++;
    if (topic === undefined) setHelpHost(null);
    setRetainedWindow((previous) => ({
      ...previous,
      topic: topic !== undefined && floating ? { id: topic, section } : null,
    }));
    // Returning to the requesting control keeps an editor ready for the next change.
    if (topic === undefined && restoreFocus) {
      requestAnimationFrame(() =>
        (helpReturn.current?.isConnected
          ? helpReturn.current
          : document.querySelector<HTMLElement>('[data-personal-menu-trigger]')
        )?.focus(),
      );
    }
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const { help: _drop, helpSection: _section, helpWindow: _window, ...rest } = prev;
        return topic === undefined
          ? rest
          : {
              ...rest,
              help: topic,
              ...(section ? { helpSection: section } : {}),
              ...(floating ? { helpWindow: 1 as const } : {}),
            };
      },
    });
  };
  useEffect(() => {
    if (help === undefined && retainedWindow.topic) {
      const topic = retainedWindow.topic;
      void navigate({
        to: '.',
        replace: true,
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          help: topic.id,
          ...(topic.section ? { helpSection: topic.section } : {}),
          helpWindow: 1 as const,
        }),
      });
    }
  }, [help, retainedWindow.topic, location.pathname, navigate]);
  useEffect(() => {
    const requested = (event: Event) => {
      const topic = (event as CustomEvent<HelpRequest>).detail;
      helpReturn.current = document.activeElement as HTMLElement;
      setHelpHost(
        helpReturn.current?.closest('.rio-modal')?.querySelector<HTMLElement>('[role="dialog"]') ?? null,
      );
      setAlsoHelp([]);
      setHelp(topic.id, true, topic.section);
    };
    document.addEventListener(HELP_REQUEST, requested);
    return () => document.removeEventListener(HELP_REQUEST, requested);
  });
  useEffect(() => {
    if (!helpHost) return;
    const changes = new MutationObserver(() => {
      if (!helpHost.isConnected) setHelpHost(null);
    });
    changes.observe(document.body, { childList: true, subtree: true });
    return () => changes.disconnect();
  }, [helpHost]);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('main, [role="dialog"]') && !target.closest('[data-help-content], .rio-palette'))
        questionControl.current = target;
    };
    document.addEventListener('focusin', remember);
    return () => document.removeEventListener('focusin', remember);
  }, []);
  const openPalette = () => {
    const control = questionControl.current?.isConnected ? questionControl.current : document.activeElement;
    void recoverImport(() => import('../docs/screen-context'))
      .then(({ collectContext }) => {
        paletteContext.current = collectContext(document, location.pathname, control);
        setPaletteOpen(true);
      })
      .catch(() => setPaletteOpen(true));
  };
  // The palette captures the screen before its focus scope hides the page.
  useShortcut('palette.open', openPalette);
  const openContextHelp = (captured?: HelpContext | null) => {
    const active = document.activeElement as HTMLElement | null;
    const control =
      active?.closest('main, [role="dialog"]') && !active.closest('.rio-palette')
        ? active
        : questionControl.current?.isConnected
          ? questionControl.current
          : null;
    helpReturn.current = control ?? document.querySelector<HTMLElement>('[data-personal-menu-trigger]');
    setHelpHost(control?.closest('.rio-modal')?.querySelector<HTMLElement>('[role="dialog"]') ?? null);
    const request = ++helpRequest.current;
    void Promise.all([
      recoverImport(() => import('../docs/loader')),
      recoverImport(() => import('../docs/context')),
      recoverImport(() => import('../docs/screen-context')),
    ])
      .then(async ([{ listModules, loadModule }, { chooseContext }, { collectContext }]) => {
        const context = captured ?? collectContext(document, location.pathname, control);
        const metadata = await listModules('en-US');
        const modules = await Promise.all(metadata.map((meta) => loadModule(meta.id, 'en-US')));
        if (request !== helpRequest.current) return;
        const result = chooseContext(
          modules.filter((module) => module !== null),
          context,
        );
        setAlsoHelp(result.others);
        setHelp(result.best?.id ?? '', true, result.best?.section);
      })
      .catch(() => {
        if (request === helpRequest.current) setHelp('');
      });
  };
  const docs = helpOpen ? (
    <LazyBoundary size="panel">
      <DocsPanel
        moduleId={activeHelp || null}
        section={activeHelpSection}
        also={alsoHelp}
        inWindow={windowOpen}
        onWindowChange={(floating) => setHelp(activeHelp ?? '', true, activeHelpSection, floating)}
        hasUnits={Boolean(session.hasUnits)}
        onOpen={(id, section) => setHelp(id, true, section)}
        onClose={() => setHelp(undefined)}
      />
    </LazyBoundary>
  ) : null;
  useShortcut('help.open', () => openContextHelp());

  const signOut = async () => {
    if (!(await requestLeave())) return;
    setSigningOut(true);
    try {
      await api('/api/auth/sign-out', { method: 'POST' });
    } catch (error) {
      // Already signed out counts as done; anything else is worth saying.
      if (!(error instanceof ApiError && error.status === 401)) {
        setSigningOut(false);
        toast.show({
          title: t({ id: 'shell.signOutFailed', message: 'Couldn’t sign out' }),
          description: message(error instanceof ApiError ? error.info.messageKey : 'errors.internal'),
          tone: 'danger',
        });
        return;
      }
    }
    setCsrfToken(null);
    queryClient.setQueryData(sessionQuery.queryKey, null);
    await navigate({ to: '/sign-in' });
  };

  // Clear the old page before a refetch can render it for another person or organization.
  if (identityChanged) return null;

  return (
    <PersonDirectory.Provider value={new Map((people.data ?? []).map((person) => [person.id, person]))}>
      <SidebarSlot.Provider value={sidebarTarget}>
        <LevelProvider session={session}>
          <PaletteSourcesProvider>
            {/* On a phone, help covers the page, so it steps aside while a demo plays and comes back after. */}
            <DemoHost
              onStart={() => {
                demoWindow.current = windowOpen;
                if (phone) setHelp(undefined, false);
              }}
              onEnd={(module) => {
                if (phone) setHelp(module.id, true, undefined, demoWindow.current);
              }}
            >
              <div
                className="rio-shell"
                data-demo={session.demo || undefined}
                data-settings-page={inSettings || undefined}
              >
                <a className="rio-skip-link" href="#main">
                  <Trans id="shell.skipToContent">Skip to main content</Trans>
                </a>
                <header className="rio-shell__header">
                  <span className="rio-shell__menu">
                    <Button
                      variant="quiet"
                      size="sm"
                      primaryAction
                      icon={faBars}
                      aria-label={t({ id: 'shell.menu', message: 'Menu' })}
                      onHoverStart={ShellDrawer.preload}
                      onFocus={ShellDrawer.preload}
                      onPress={() => setMenuOpen(true)}
                    />
                  </span>
                  <Link to="/" className="rio-shell__brand">
                    <AppLogo />
                  </Link>
                  <div className="rio-shell__header-end">
                    <span onMouseEnter={CommandPalette.preload} onFocus={CommandPalette.preload}>
                      <PaletteButton onPress={openPalette} />
                    </span>
                    <span className="rio-shell__org">{session.org.name}</span>
                    {compactHeader ? <CompactHeaderStatus /> : <UpdateNotice />}
                    {!session.demo && <NotificationBell />}
                    {/* Personal actions stay reachable from every signed-in screen. */}
                    {inSettings && (
                      <Button
                        variant="quiet"
                        size="sm"
                        primaryAction
                        icon={faXmark}
                        aria-label={t({ id: 'shell.settings.close', message: 'Close settings' })}
                        onPress={() => {
                          void requestLeave().then((accepted) => {
                            if (accepted) void navigate({ to: returnTo });
                          });
                        }}
                      />
                    )}
                    <RioLauncher phone={phone} />
                    <PersonalMenu
                      demo={session.demo}
                      user={session.user}
                      signingOut={signingOut}
                      onSettings={openSettings}
                      onAppearance={() => setOverlay('appearance', true)}
                      onShortcuts={() => setOverlay('shortcuts', true)}
                      onHelp={() => openContextHelp()}
                      onFeedback={() => setFeedbackOpen(true)}
                      onSignOut={() => void signOut()}
                    />
                    {rioPreview && (
                      <LazyBoundary
                        key={rioPreview}
                        size="dialog"
                        onDismiss={() => {
                          void navigate({
                            to: location.pathname,
                            search: (previous) => ({
                              ...previous,
                              rioPreview: undefined,
                              rioPreviewTarget: undefined,
                            }),
                          });
                        }}
                      >
                        <PlanPreview />
                      </LazyBoundary>
                    )}
                  </div>
                </header>
                {session.demo && (
                  <div className="rio-demo-banner" role="note">
                    {t({ id: 'demo.readOnly', message: "This is a read-only demo.  Changes aren't saved." })}
                    {session.demoLink && (
                      <a href={session.demoLink} target="_blank" rel="noopener noreferrer">
                        <Trans id="demo.about">About Riosoma</Trans>
                      </a>
                    )}
                  </div>
                )}
                <div className="rio-shell__body">
                  <nav
                    className="rio-shell__sidebar"
                    style={{ inlineSize: width }}
                    aria-label={t({ id: 'shell.sidebar', message: 'Sidebar' })}
                  >
                    {!phone && <div className="rio-shell__sidebar-slot" ref={setSidebarTarget} />}
                    <div className="rio-shell__default-nav">
                      <NavLinks />
                    </div>
                    <SidebarResizer width={width} onChange={setWidth} />
                  </nav>
                  <main className="rio-shell__main" id="main" tabIndex={-1}>
                    <RetainedSession.Provider value={signedOut ? session : null}>
                      <Outlet />
                    </RetainedSession.Provider>
                  </main>
                  {helpOpen && !phone && !helpHost ? (
                    <div className={windowOpen ? undefined : 'rio-shell__dock'}>{docs}</div>
                  ) : null}
                </div>
                {helpOpen && helpHost
                  ? createPortal(
                      <div className={windowOpen ? undefined : 'rio-docs-modal-panel'}>{docs}</div>,
                      helpHost,
                    )
                  : null}
                {helpOpen && windowOpen && phone && !helpHost ? docs : null}
                {phone && helpOpen && !windowOpen && !helpHost ? (
                  <LazyBoundary size="dialog" onDismiss={() => setHelp(undefined)}>
                    <ShellDrawer
                      title={t({ id: 'shell.help', message: 'Help' })}
                      onClose={() => setHelp(undefined)}
                    >
                      {docs}
                    </ShellDrawer>
                  </LazyBoundary>
                ) : null}
                <ShellFooter
                  brand={
                    session.org.settings.logo && (
                      <span className="rio-platform-mark">
                        <RiosomaLogo variant="wordmark" />
                        {version && (
                          <span>{t({ id: 'branding.platform.version', message: `Version ${version}` })}</span>
                        )}
                      </span>
                    )
                  }
                  page={<SettingsDraftFooter />}
                />
                {menuOpen && (
                  <LazyBoundary size="dialog" onDismiss={() => setMenuOpen(false)}>
                    <ShellDrawer
                      side="start"
                      title={t({ id: 'shell.menu', message: 'Menu' })}
                      onClose={() => setMenuOpen(false)}
                    >
                      <nav aria-label={t({ id: 'shell.sidebar', message: 'Sidebar' })}>
                        {/* Following a link closes the menu. */}
                        {phone && (
                          <div
                            className="rio-shell__sidebar-slot"
                            ref={setSidebarTarget}
                            onClick={(event) => {
                              if (event.target instanceof Element && event.target.closest('a'))
                                setMenuOpen(false);
                            }}
                          />
                        )}
                        <div className="rio-shell__default-nav">
                          <NavLinks onNavigate={() => setMenuOpen(false)} />
                        </div>
                      </nav>
                      <Button
                        variant="quiet"
                        icon={faCommentDots}
                        onPress={() => {
                          setMenuOpen(false);
                          setFeedbackOpen(true);
                        }}
                      >
                        {t({ id: 'shell.helpMenu.feedback', message: 'Send feedback' })}
                      </Button>
                    </ShellDrawer>
                  </LazyBoundary>
                )}
                {paletteOpen && (
                  <LazyBoundary size="dialog" onDismiss={() => setPaletteOpen(false)}>
                    <CommandPalette
                      isOpen={paletteOpen}
                      onClose={() => setPaletteOpen(false)}
                      canManagePeople={canManagePeople(session)}
                      canUseTokens={canUseTokens(session)}
                      canOpenUnits={canOpenUnits(session)}
                      // Help opens over whatever page the person is on, at the topic a command names, or else
                      // at the one they were reading.
                      onOpenHelp={(topic) =>
                        topic ? setHelp(topic) : openContextHelp(paletteContext.current)
                      }
                      onSendFeedback={() => setFeedbackOpen(true)}
                      onSignOut={() => void signOut()}
                    />
                  </LazyBoundary>
                )}
                {feedbackOpen && (
                  <LazyBoundary size="dialog" onDismiss={() => setFeedbackOpen(false)}>
                    <FeedbackDialog isOpen onClose={() => setFeedbackOpen(false)} />
                  </LazyBoundary>
                )}
                {shortcuts && (
                  <LazyBoundary size="dialog" onDismiss={() => setOverlay('shortcuts', false)}>
                    <ShortcutHelp isOpen onOpenChange={(open) => setOverlay('shortcuts', open)} />
                  </LazyBoundary>
                )}
                {appearance && (
                  <LazyBoundary size="dialog" onDismiss={() => setOverlay('appearance', false)}>
                    <QuickAppearance onClose={() => setOverlay('appearance', false)} />
                  </LazyBoundary>
                )}
                <CelebrationLayer />
                {signedOut && !signingOut && !session.demo ? (
                  <LazyBoundary size="dialog">
                    <ReauthenticationDialog identity={session} deactivated={deactivated} />
                  </LazyBoundary>
                ) : null}
              </div>
            </DemoHost>
          </PaletteSourcesProvider>
        </LevelProvider>
      </SidebarSlot.Provider>
    </PersonDirectory.Provider>
  );
}
