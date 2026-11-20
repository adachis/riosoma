import { randomBytes } from 'node:crypto';
import {
  expect,
  request,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';
import { base } from './base';
import { SETUP_TOKEN } from './stack';
import { documentIdentity } from './accessibility';

/**
 * What the feature specs share: the owner's account, signing in, and databases made through the
 * app's own API, so each spec starts from records of its own and spends its time on the feature.
 *
 * Every feature spec carries a letter prefix, `m-…` and friends, so it sorts after the journey,
 * which creates the owner on a fresh server.  A spec without one that sorts before the journey
 * signs in first and leaves the setup step nothing to do.  A spec run on its own creates the same
 * owner through the setup API instead.
 */
export const OWNER = {
  org: 'Tidewater Books',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  password: 'correct horse battery staple',
};

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** An identifier the server accepts: the kind's prefix, then 14 random base-62 characters. */
export function newId(
  prefix:
    'db' | 'tbl' | 'fld' | 'fnc' | 'viw' | 'rec' | 'cho' | 'cmd' | 'act' | 'cli' | 'rul' | 'aut' | 'scr',
): string {
  let id: string = prefix;
  for (const byte of randomBytes(14)) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

/** Creates the owner when the server is still waiting for one, as it is when a spec runs alone. */
export async function ensureOwner(): Promise<void> {
  const api = await request.newContext();
  try {
    const status = await (await api.get(`${base()}/api/setup/status`)).json();
    if (status.stage === 'ready') return;
    const created = await api.post(`${base()}/api/setup/owner`, {
      headers: { 'x-setup-token': SETUP_TOKEN },
      data: { orgName: OWNER.org, name: OWNER.name, email: OWNER.email, password: OWNER.password },
    });
    if (created.ok()) return;
    // Two workers that start on a fresh server both find it waiting, and only one creates the owner.
    const body = await created.text();
    const after = await (await api.get(`${base()}/api/setup/status`)).json();
    expect(created.status() === 409 && after.stage === 'ready', body).toBe(true);
  } finally {
    await api.dispose();
  }
}

/**
 * Callers wait for their screen's controls after a full-document visit.  Tests that hold a boot
 * request to inspect a loading state can opt out of app readiness while still waiting for the
 * replacement document.
 */
export async function visit(
  page: Page,
  url: string,
  { waitForAppLoaded = true }: { waitForAppLoaded?: boolean } = {},
): Promise<void> {
  const chromium = page.context().browser()?.browserType().name() === 'chromium';
  const origin = chromium ? new URL(url, page.url()).origin : undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const previous = await documentIdentity(page);
    const interrupted = new AbortController();
    let failure: { url: string; errorText: string } | undefined;
    const requestFailed = (request: Request) => {
      const errorText = request.failure()?.errorText;
      if (!failure && errorText === 'net::ERR_NETWORK_CHANGED' && new URL(request.url()).origin === origin) {
        failure = { url: request.url(), errorText };
        interrupted.abort();
      }
    };
    // Host address changes can flush Chromium's loopback boot requests before React mounts.
    // Revisit once for that interruption; other failures retain their existing behavior.
    if (chromium) page.on('requestfailed', requestFailed);
    try {
      if (page.context().browser()?.browserType().name() === 'firefox') {
        // Firefox's navigation command can leave stale state that also blocks later input actions.
        // Navigate in the page and wait for the replacement document before using its controls.
        // Document identity stays reliable even when the browser rounds navigation timestamps.
        await page.evaluate((destination) => window.location.assign(destination), url);
      } else {
        await page.goto(url, { waitUntil: 'commit', signal: interrupted.signal });
      }
      const ready = await page.waitForFunction(
        ({ identity, waitForAppLoaded }) => {
          const root = document.getElementById('root');
          // An interactive document can still be loading route modules or the database schema.
          // Wait for the app's page loading states before starting the caller's control assertions.
          // Published sites are rendered on the server and have no app root to wait for.
          return (
            Reflect.get(document, Symbol.for('rio.accessibility.document')) !== identity &&
            document.readyState !== 'loading' &&
            (!waitForAppLoaded ||
              !root ||
              // The built HTML puts a hidden recovery screen here before React mounts.
              // It is not app content and cannot establish that the route has started loading.
              ([...root.children].some((child) => child.id !== 'rio-startup-error') &&
                !root.querySelector(
                  '.rio-feature-loading--page[aria-busy="true"], .rio-database-screen[aria-busy="true"]',
                )))
          );
        },
        { identity: previous, waitForAppLoaded },
        { signal: interrupted.signal },
      );
      await ready.dispose();
      return;
    } catch (error) {
      if (!failure) throw error;
      if (attempt === 1)
        throw new Error(
          `Network changed again while visiting ${url}: ${failure.url} failed with ${failure.errorText}`,
          { cause: error },
        );
    } finally {
      if (chromium) page.off('requestfailed', requestFailed);
      interrupted.abort();
    }
  }
}

/** Signs the owner in through the sign-in page and waits for the list of databases. */
export async function signIn(page: Page): Promise<void> {
  await ensureOwner();
  await visit(page, `${base()}/sign-in`);
  await page.getByLabel('Email address').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  await everyFeature(page);
}

/**
 * The owner walks through every feature, so the specs work at Advanced, where nothing is tidied
 * away.  The choice stays with the owner, so only the first spec to sign in has to make it.
 */
async function everyFeature(page: Page): Promise<void> {
  const session = await page.request.get(`${base()}/api/auth/session`);
  const { preferences } = (await session.json()) as { preferences: { level?: string } };
  if (preferences.level === 'advanced') return;
  await asOwner(page, 'PATCH', '/api/me/preferences', { level: 'advanced' });
  await visit(page, page.url());
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
}

/**
 * Sends a request as the person signed in on this page.  The session rides on the page's cookie,
 * and anything that changes data also carries the session's CSRF token, as the app's own do.
 */
export async function asOwner<T>(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<T> {
  const session = await page.request.get(`${base()}/api/auth/session`);
  expect(session.ok(), 'the page has a signed-in session').toBe(true);
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const response = await page.request.fetch(`${base()}${path}`, {
    method,
    headers: { 'x-csrf-token': csrfToken },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return (response.status() === 204 ? undefined : await response.json()) as T;
}

/** Runs database commands as one action, the way the app sends a person's changes. */
export async function runCommands(page: Page, databaseId: string, commands: object[]): Promise<void> {
  const groupId = newId('act');
  const result = await asOwner<{ results: Array<{ status: string; error?: unknown }> }>(
    page,
    'POST',
    `/api/databases/${databaseId}/commands`,
    {
      clientId: newId('cli'),
      commands: commands.map((command) => ({ id: newId('cmd'), groupId, ...command })),
    },
  );
  expect(result.results.filter((item) => item.status === 'rejected')).toEqual([]);
}

export interface FieldPlan {
  name: string;
  type: string;
  /** For select fields: the choices' names */
  choices?: string[];
  /** Any other options the field type takes, such as a date field's `includeTime` */
  options?: Record<string, unknown>;
}

export interface TablePlan {
  name: string;
  /** The first field is the primary field */
  fields: FieldPlan[];
  /** Values by field name, with a select field's value given as the choice's name */
  records?: Array<Record<string, unknown>>;
}

export interface SeededTable {
  id: string;
  viewId: string;
  /** Field IDs by name */
  fields: Record<string, string>;
  /** Choice IDs by field name, then by choice name */
  choices: Record<string, Record<string, string>>;
  /** Record IDs, in the order the plan lists the records */
  records: string[];
}

export interface SeededDatabase {
  id: string;
  tables: Record<string, SeededTable>;
}

const COLORS = ['blue', 'green', 'yellow', 'purple', 'orange', 'teal'];

/**
 * Makes a database with these tables and records through the API.  The first table comes with the
 * database, the rest follow as `table.create`, and the records as `record.create`.
 */
export async function createDatabase(page: Page, name: string, tables: TablePlan[]): Promise<SeededDatabase> {
  const id = newId('db');
  const seeded: SeededDatabase = { id, tables: {} };
  const built = tables.map((plan) => {
    const choiceIds = new Map<string, Map<string, string>>();
    const fields = plan.fields.map((field) => {
      const fieldId = newId('fld');
      const options = field.options ?? {};
      if (!field.choices) return { id: fieldId, name: field.name, type: field.type, options };
      const choices = field.choices.map((choice, index) => ({
        id: newId('cho'),
        name: choice,
        color: COLORS[index % COLORS.length],
      }));
      choiceIds.set(field.name, new Map(choices.map((choice) => [choice.name, choice.id])));
      return { id: fieldId, name: field.name, type: field.type, options: { ...options, choices } };
    });
    const table = {
      id: newId('tbl'),
      name: plan.name,
      description: '',
      fields,
      view: { id: newId('viw'), name: 'Grid' },
      records: [],
    };
    const fieldIds = Object.fromEntries(fields.map((field) => [field.name, field.id]));
    const records = (plan.records ?? []).map((values) => ({
      id: newId('rec'),
      values: Object.fromEntries(
        Object.entries(values).map(([field, value]) => [
          fieldIds[field]!,
          choiceIds.get(field)?.get(String(value)) ?? value,
        ]),
      ),
    }));
    seeded.tables[plan.name] = {
      id: table.id,
      viewId: table.view.id,
      fields: fieldIds,
      choices: Object.fromEntries(
        [...choiceIds].map(([field, choices]) => [field, Object.fromEntries(choices)]),
      ),
      records: records.map((record) => record.id),
    };
    return { table, records };
  });
  const [first, ...rest] = built;
  await asOwner(page, 'POST', '/api/databases', { id, name, icon: null, color: 'blue', table: first!.table });
  const commands: object[] = rest.map(({ table }) => ({ kind: 'table.create', table }));
  for (const { table, records } of built)
    if (records.length) commands.push({ kind: 'record.create', tableId: table.id, records });
  if (commands.length) await runCommands(page, id, commands);
  return seeded;
}

/** Adds a view of this type to a seeded table through the API, and returns its ID. */
export async function createView(
  page: Page,
  database: SeededDatabase,
  table: string,
  view: { name: string; type: string; config?: object },
): Promise<string> {
  const id = newId('viw');
  await runCommands(page, database.id, [
    {
      kind: 'view.create',
      view: {
        id,
        tableId: database.tables[table]!.id,
        name: view.name,
        type: view.type,
        config: view.config ?? {},
      },
    },
  ]);
  return id;
}

/**
 * Ticks a checkbox by its visible label.  The input itself is visually hidden under the box the
 * theme draws, so this clicks the label, as a person does.
 */
export async function tick(scope: Page | Locator, label: string): Promise<void> {
  await scope.getByText(label, { exact: true }).click();
  await expect(scope.getByRole('checkbox', { name: label })).toBeChecked();
}

/**
 * Flips a switch from the keyboard, since its input also sits under what the theme draws.  A switch
 * waits while what it controls is loading, so this waits for it too.
 */
export async function flip(control: Locator): Promise<void> {
  await expect(control).toBeEnabled();
  await control.press('Space');
}

/** Opens a database's table and waits for its grid. */
export async function openTable(page: Page, database: SeededDatabase, table: string): Promise<Locator> {
  const { id, viewId } = database.tables[table]!;
  await visit(page, `${base()}/${database.id}/${id}/${viewId}`);
  const grid = page.getByRole('grid', { name: 'Grid' });
  await expect(grid).toBeVisible();
  return grid;
}

/** Firefox drops a constructor's clipboard payload, so attach it to the event before dispatch. */
export async function pasteText(input: Locator, text: string): Promise<void> {
  const received = await input.evaluate((element, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboardData });
    element.dispatchEvent(event);
    return event.clipboardData?.getData('text/plain');
  }, text);
  expect(received).toBe(text);
}

/**
 * Answers the map style's host from here, so a map view draws its pins on a plain background with
 * no tiles and nothing from the network.
 */
export async function offlineMap(scope: Page | BrowserContext): Promise<void> {
  await scope.route('https://tiles.openfreemap.org/**', async (route) => {
    if (!route.request().url().includes('/styles/')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 8,
        sources: {},
        layers: [{ id: 'water', type: 'background', paint: { 'background-color': '#c9dcea' } }],
      }),
    });
  });
}

/**
 * Everything a page's browser receives from here on: each response's body and each socket message.
 * Call the function it returns to wait for all of it, then look for what must never arrive.
 */
export function everythingReceived(page: Page): () => Promise<string[]> {
  const received: Array<Promise<string>> = [];
  page.on('response', (response) => {
    received.push(
      response.body().then(
        (body) => body.toString('utf8'),
        // A redirect has no body of its own.
        () => '',
      ),
    );
  });
  page.on('websocket', (socket) => {
    socket.on('framereceived', (frame) => received.push(Promise.resolve(String(frame.payload))));
  });
  return () => Promise.all(received);
}

/** Matches a visible label followed by the rest of a control's accessible name. */
export function labelName(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?: |$)`);
}
