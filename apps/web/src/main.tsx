import '@riosoma/tokens/base.css';
import './app.css';
import { StrictMode, useLayoutEffect } from 'react';
import { msg } from '@lingui/core/macro';
import { toast } from '@riosoma/ui';
import { I18nProvider } from '@lingui/react';
import { i18n } from './i18n';
import { BootError } from './shell/BootError';
import { AppErrorBoundary } from './shell/AppErrorBoundary';
import { messages as recoveryMessages } from './locales/en-US/messages.po?recovery';
import {
  AssetLoadError,
  installAssetRecovery,
  recoverAssets,
  isAssetLoadError,
  reloadPage,
} from './asset-recovery';
import { createRoot } from 'react-dom/client';
import { App, createAppContext } from './App';
import { installErrorCapture } from './features/feedback/errors';
import { activateLocale } from './i18n';
import { rememberedLocale, rememberLocale, themeFor } from './preferences';
import { firstPaintTheme } from './shell/firstPaintTheme';
import { appliedSettings, sessionQuery, setupStatusQuery } from './session';
import { onPublicDomain } from './public-domain';
import { startServiceWorker } from './pwa';

// Feedback can say what went wrong just before someone wrote in, so errors are kept from the start.
installErrorCapture();
installAssetRecovery();
const root = createRoot(document.getElementById('root')!);
let appMounted = false;

function MountedApp() {
  useLayoutEffect(() => {
    appMounted = true;
    window.dispatchEvent(new Event('rio:app-ready'));
  }, []);
  return null;
}

function renderStartupError(error: unknown) {
  if (!i18n.locale) {
    i18n.load('en-US', recoveryMessages);
    i18n.activate('en-US');
  }
  root.render(
    <I18nProvider i18n={i18n}>
      <BootError error={error} />
    </I18nProvider>,
  );
}

window.addEventListener('rio:asset-load-failed', () => {
  if (!appMounted) {
    renderStartupError(new AssetLoadError());
    return;
  }
  toast.show({
    tone: 'warning',
    title: i18n._(msg({ id: 'app.load.part.title', message: "That part couldn't load" })),
    description: i18n._(msg({ id: 'app.load.part.body', message: 'Check your connection and try again.' })),
    action: {
      label: i18n._(msg({ id: 'app.load.reload', message: 'Reload' })),
      onPress: reloadPage,
    },
  });
});

async function boot() {
  const context = createAppContext();
  // Resolve the signed-in person's language before requesting a catalog, so startup downloads
  // only the active locale even when this browser last belonged to someone else.
  const signedInRoute =
    !onPublicDomain() &&
    context.router.matchRoutes(window.location.pathname).some((match) => match.routeId === '/app');
  const setup = signedInRoute
    ? await context.queryClient.ensureQueryData(setupStatusQuery).catch(() => null)
    : null;
  const session =
    setup?.stage === 'ready'
      ? await context.queryClient.ensureQueryData(sessionQuery).catch(() => null)
      : null;
  const locale =
    new URLSearchParams(window.location.search).get('lang') ??
    session?.preferences.locale ??
    appliedSettings(session)?.defaultLocale ??
    session?.user.locale ??
    rememberedLocale();
  rememberLocale(await activateLocale(locale));
  if (session) await firstPaintTheme(themeFor(session.preferences, appliedSettings(session)));
  // First-install caching must see the completed startup catalog request.
  startServiceWorker();
  root.render(
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <AppErrorBoundary>
          <MountedApp />
          <App context={context} />
        </AppErrorBoundary>
      </I18nProvider>
    </StrictMode>,
  );
}

void boot().catch(async (error: unknown) => {
  if (isAssetLoadError(error) && (await recoverAssets())) return;
  renderStartupError(error);
});
