import '../../../packages/tokens/src/base.css';
import 'virtual:riosoma-theme.css';
import './popup.css';
import { browser, target } from './browser';
import { originPattern } from './manifest';
import {
  chooseCatalog,
  clipperOrigin,
  destinationHash,
  readDestination,
  saveClip,
  type ApiCall,
  type Destination,
  type Mapping,
  type PageClip,
} from './model';
import { textTypes, writable, type Table } from '../../shared/schema';
import {
  activate,
  errorKey,
  IntegrationError,
  isIntegrationMessage,
  message,
  type Catalog,
  type IntegrationMessage,
} from '../../../packages/ui/src/integrations/messages';
declare const __CLIPPER_CATALOGS__: Record<string, Catalog>;
declare const __CLIPPER_THEME__: { theme: string; light: string; dark: string };

// The browser's language picks the catalog.  A string not translated yet stays in English.
const { language, catalog } = chooseCatalog(browser.i18n.getUILanguage(), __CLIPPER_CATALOGS__);
if (catalog) activate(language, catalog);
document.documentElement.lang = language;
// The app's default theme, in its dark color scheme when the system prefers dark.
const dark = matchMedia('(prefers-color-scheme: dark)');
const followSystem = () => {
  document.documentElement.dataset.scheme = dark.matches ? __CLIPPER_THEME__.dark : __CLIPPER_THEME__.light;
};
document.documentElement.dataset.theme = __CLIPPER_THEME__.theme;
followSystem();
dark.addEventListener('change', followSystem);

const root = document.querySelector<HTMLElement>('#app')!;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, id?: IntegrationMessage) => {
  const node = document.createElement(tag);
  if (id) node.textContent = message(id);
  return node;
};
const title = element('h1', 'clipper.name');
document.title = message('clipper.name');
const status = element('p');
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');
const help = element('a', 'clipper.help');
help.href = '#help';
const helpPanel = element('section');
helpPanel.append(element('p', 'clipper.helpText'));
const back = element('a', 'clipper.back');
helpPanel.append(back);
const auth = element('form');
const address = input(auth, 'clipper.address', 'url');
address.placeholder = 'https://';
address.disabled = true;
const client = input(auth, 'integration.client', 'text');
client.autocomplete = 'off';
client.disabled = true;
const redirect = element('label', 'clipper.redirect');
const redirectValue = element('input');
redirectValue.readOnly = true;
redirectValue.value = browser.identity.getRedirectURL();
redirect.append(redirectValue);
auth.append(redirect);
const signIn = element('button', 'clipper.signIn');
signIn.type = 'submit';
signIn.disabled = true;
auth.append(signIn);
const form = element('form');
const fields = element('fieldset');
form.append(fields);
const databases = select(fields, 'integration.database');
const tables = select(fields, 'integration.table');
const pageTitle = input(fields, 'clipper.title', 'text');
const pageUrl = input(fields, 'clipper.url', 'url');
const selectedLabel = element('label', 'clipper.selection');
const selectedText = element('textarea');
selectedText.rows = 3;
selectedLabel.append(selectedText);
fields.append(selectedLabel);
const mapping = {
  title: select(fields, 'clipper.titleField'),
  url: select(fields, 'clipper.urlField'),
  selection: select(fields, 'clipper.selectionField'),
  screenshot: select(fields, 'clipper.screenshotField'),
};
mapping.screenshot.required = false;
const screenshot = input(fields, 'clipper.screenshot', 'checkbox');
screenshot.required = false;
const save = element('button', 'clipper.save');
save.type = 'submit';
fields.append(save);
const signOut = element('button', 'clipper.signOut');
signOut.type = 'button';
const openRecord = element('a', 'clipper.open');
openRecord.target = '_blank';
openRecord.rel = 'noopener noreferrer';
openRecord.hidden = true;
form.hidden = true;
signOut.hidden = true;
helpPanel.hidden = true;
root.append(title, status, auth, form, openRecord, signOut, help, helpPanel);
let destination: Destination = readDestination(location.hash);
let available: Table[] = [];
let signedIn = false;
let generation = 0;
let busy = false;
let saved = false;
let pageTab: { id: number; windowId: number; url: string } | undefined;
let origin = '';
const api = (call: ApiCall) => send({ kind: 'api', call });

async function send(request: unknown): Promise<unknown> {
  const response = await browser.runtime.sendMessage(request);
  if (response.error)
    throw new IntegrationError(isIntegrationMessage(response.error) ? response.error : 'integration.failed');
  return response.value;
}
function input(parent: HTMLElement, id: IntegrationMessage, type: string) {
  const label = element('label', id);
  const node = element('input');
  node.type = type;
  node.required = true;
  label.append(node);
  parent.append(label);
  return node;
}
function select(parent: HTMLElement, id: IntegrationMessage) {
  const label = element('label', id);
  const node = element('select');
  node.id = id;
  node.required = true;
  label.htmlFor = node.id;
  parent.append(label, node);
  return node;
}
function options(node: HTMLSelectElement, items: { id: string; name: string }[], current: string) {
  node.replaceChildren();
  const empty = element('option', 'integration.choose');
  empty.value = '';
  node.append(empty);
  for (const item of items) {
    const option = element('option');
    option.value = item.id;
    option.textContent = item.name;
    node.append(option);
  }
  node.value = items.some((item) => item.id === current) ? current : '';
}
function navigate() {
  const showingHelp = location.hash === '#help';
  auth.hidden = signedIn || showingHelp;
  form.hidden = !signedIn || showingHelp;
  signOut.hidden = !signedIn || showingHelp;
  helpPanel.hidden = !showingHelp;
  help.hidden = showingHelp;
  back.href = destinationHash(destination);
}
function remember() {
  destination = {
    database: databases.value,
    table: tables.value,
    mapping: Object.fromEntries(
      Object.entries(mapping).map(([key, node]) => [key, node.value]),
    ) as unknown as Mapping,
  };
  history.replaceState(null, '', destinationHash(destination));
  back.href = destinationHash(destination);
  void browser.storage.local.set({ destination }).catch(fail);
}
function fail(error: unknown) {
  status.textContent = message(errorKey(error));
}
async function run(action: () => Promise<void>) {
  if (busy || saved) return;
  busy = true;
  fields.disabled = true;
  signIn.disabled = true;
  signOut.disabled = true;
  status.textContent = '';
  try {
    await action();
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    fields.disabled = saved;
    signIn.disabled = false;
    signOut.disabled = false;
  }
}
function fillMappings() {
  const table = available.find((item) => item.id === tables.value);
  for (const [key, node] of Object.entries(mapping)) {
    options(
      node,
      (table?.fields ?? []).filter(
        (field) =>
          writable(field) && (key === 'screenshot' ? field.type === 'attachment' : textTypes.has(field.type)),
      ),
      destination.mapping[key as keyof Mapping],
    );
  }
  save.disabled = !table;
}
async function loadTables() {
  const current = ++generation;
  available = [];
  options(tables, [], '');
  fillMappings();
  if (!databases.value) return;
  const result = (await api({ path: `/databases/${encodeURIComponent(databases.value)}/tables` })) as {
    tables: Table[];
  };
  if (current !== generation) return;
  available = result.tables;
  options(tables, available, destination.table);
  fillMappings();
  if (!available.length) status.textContent = message('clipper.noTables');
}
async function load() {
  signedIn = Boolean(await send({ kind: 'session' }));
  navigate();
  if (!signedIn) return;
  const result = (await api({ path: '/databases' })) as { databases: { id: string; name: string }[] };
  options(databases, result.databases, destination.database);
  await loadTables();
}
async function capture() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !['http:', 'https:'].includes(new URL(tab.url).protocol))
    throw new IntegrationError('clipper.captureFailed');
  const result = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.getSelection()?.toString() ?? '',
  });
  pageTab = { id: tab.id, windowId: tab.windowId, url: tab.url };
  pageTitle.value = tab.title ?? '';
  pageUrl.value = tab.url;
  selectedText.value = result[0]?.result ?? '';
}

auth.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    const chosen = clipperOrigin(address.value);
    // Saved first, so the values are still here if the browser closes the popup while it asks.
    void browser.storage.local.set({ origin: chosen, clientId: client.value.trim() }).catch(fail);
    // Firefox grants access only when it's requested straight from the click, before any wait.
    if (!(await browser.permissions.request({ origins: [originPattern(chosen, target)] })))
      throw new IntegrationError('clipper.permissionDenied');
    origin = chosen;
    address.value = chosen;
    await browser.storage.local.set({ origin: chosen, clientId: client.value.trim() });
    await send({ kind: 'signIn', clientId: client.value });
    await load();
  });
});
signOut.addEventListener('click', () => {
  saved = false;
  void run(async () => {
    try {
      await send({ kind: 'signOut' });
    } finally {
      signedIn = false;
      openRecord.hidden = true;
      navigate();
    }
  });
});
databases.addEventListener('change', () => {
  destination = {
    ...destination,
    database: databases.value,
    table: '',
    mapping: { title: '', url: '', selection: '', screenshot: '' },
  };
  void loadTables().then(remember).catch(fail);
});
tables.addEventListener('change', () => {
  destination = {
    ...destination,
    table: tables.value,
    mapping: { title: '', url: '', selection: '', screenshot: '' },
  };
  fillMappings();
  remember();
});
for (const node of Object.values(mapping)) node.addEventListener('change', remember);
form.addEventListener('keydown', (event) => {
  if (
    event.key === 'Enter' &&
    (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)
  )
    event.preventDefault();
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    const table = available.find((item) => item.id === tables.value);
    if (!table) throw new IntegrationError('integration.invalid');
    remember();
    status.textContent = message('clipper.saving');
    const clip: PageClip = { title: pageTitle.value, url: pageUrl.value, selection: selectedText.value };
    let image: string | undefined;
    if (screenshot.checked) {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!pageTab || tab?.id !== pageTab.id || tab.url !== pageTab.url)
        throw new IntegrationError('clipper.captureFailed');
      image = await browser.tabs.captureVisibleTab(pageTab.windowId, { format: 'png' });
    }
    const recordId = await saveClip(api, destination, table, clip, image);
    status.textContent = message('clipper.saved');
    openRecord.href = `${clipperOrigin(origin)}/${encodeURIComponent(destination.database)}/${encodeURIComponent(table.id)}${table.views[0] ? `/${encodeURIComponent(table.views[0].id)}/${encodeURIComponent(recordId)}` : ''}`;
    openRecord.hidden = false;
    saved = true;
    openRecord.focus();
  });
});
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#clip?')) {
    destination = readDestination(location.hash);
    void load().catch(fail);
  }
  navigate();
});
void (async () => {
  const stored = await browser.storage.local.get('destination');
  if (!location.hash.includes('?') && stored.destination) destination = stored.destination as Destination;
  const storedOrigin = (await browser.storage.local.get('origin')).origin;
  origin = typeof storedOrigin === 'string' ? storedOrigin : '';
  address.value = origin;
  client.value = String((await browser.storage.local.get('clientId')).clientId ?? '');
  await Promise.all([capture().catch(fail), load()]);
})()
  .catch(fail)
  .finally(() => {
    signIn.disabled = false;
    address.disabled = false;
    client.disabled = false;
  });
