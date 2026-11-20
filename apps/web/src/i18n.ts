import { i18n, type Messages } from '@lingui/core';
// Startup uses negotiation directly so the display names stay with the settings feature.
import {
  localeDirection,
  matchLocale,
  PSEUDO_LOCALE,
  RTL_PSEUDO_LOCALE,
  SOURCE_LOCALE,
} from '../../../packages/i18n/src/available';

const catalogs = import.meta.glob<{ messages: Messages }>('./locales/*/messages.po');
const shellCatalogs = import.meta.glob<{ messages: Messages }>('./locales/*/messages.po', {
  query: '?shell',
});
let featuresOpened = false;
let activation = 0;
const loadedFeatures = new Map<string, Promise<void>>();
const loadDescriptors = () => Promise.all([import('./messages/server'), import('./messages/formula')]);

/** A feature waits for its active translations as well as its component. */
export async function loadFeatureCatalog(): Promise<void> {
  featuresOpened = true;
  const code = i18n.locale;
  if (!code) return;
  let pending = loadedFeatures.get(code);
  if (!pending) {
    pending = Promise.all([loadMessages(code, catalogs), loadDescriptors()]).then(([messages]) => {
      i18n.load(code, messages);
    });
    loadedFeatures.set(code, pending);
    void pending.catch(() => loadedFeatures.delete(code));
  }
  await pending;
  if (i18n.locale !== code) await loadFeatureCatalog();
}

async function loadMessages(code: string, available: typeof catalogs): Promise<Messages> {
  const catalog = code === RTL_PSEUDO_LOCALE ? PSEUDO_LOCALE : code;
  const load =
    available[`./locales/${catalog}/messages.po`] ?? available[`./locales/${SOURCE_LOCALE}/messages.po`];
  return load ? (await load()).messages : {};
}

/** Loads a locale's catalog and switches the whole app, including the page's lang and direction. */
export async function activateLocale(requested: string | null | undefined): Promise<string> {
  const code = matchLocale([requested, ...navigator.languages]);
  const version = ++activation;
  let messages = await loadMessages(code, featuresOpened ? catalogs : shellCatalogs);
  // A feature can open while this locale is still loading.
  if (featuresOpened) [messages] = await Promise.all([loadMessages(code, catalogs), loadDescriptors()]);
  if (version !== activation) return i18n.locale;
  i18n.load(code, messages);
  i18n.activate(code);
  const root = document.documentElement;
  root.lang = code;
  root.dir = localeDirection(code);
  return code;
}

export { i18n, matchLocale };
