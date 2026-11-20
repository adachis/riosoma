import { i18n as globalI18n, setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  AutomationConfig,
  FieldMeta,
  GridConfig,
  newId,
  type AutomationMeta,
  type DatabaseRole,
  type SessionInfo,
} from '@riosoma/contracts';
import { ConfirmProvider, ToastRegion } from '@riosoma/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider as LocaleProvider } from 'react-aria-components';
import { ApiError, type ApiOptions } from '../../../api';
import { useSchema } from '../../../data/hooks';
import { openDatabase } from '../../../data/session';
import { FakeRecords, FakeServer } from '../../../data/testing';
import type { DatabaseSession } from '../../../data/types';
import { sessionQuery } from '../../../session';
import { patchTreeWalkerPreviousNode } from '../../../../../../packages/ui/src/test/tree-walker';
import { AutomationScreen } from './AutomationScreen';

patchTreeWalkerPreviousNode();
// Toasts and reported errors read the app's shared catalog.
globalI18n.load('en-US', {});
globalI18n.activate('en-US');

export interface AutomationFixture {
  server: FakeServer;
  session: DatabaseSession;
  databaseId: string;
  tasks: {
    id: string;
    viewId: string;
    formId: string;
    name: string;
    number: string;
    email: string;
    notes: string;
    created: string;
    recordId(index: number): string;
  };
  people: { id: string; viewId: string; name: string; email: string };
}

export interface FixtureOptions {
  role?: DatabaseRole;
  /** Automations to start with, given the new database's IDs */
  automations?: (ids: Omit<AutomationFixture, 'server' | 'session'>) => AutomationMeta[];
}

function field(
  tableId: string,
  id: string,
  name: string,
  type: FieldMeta['type'],
  position: number,
): FieldMeta {
  return FieldMeta.parse({
    id,
    tableId,
    name,
    type,
    options: {},
    description: '',
    position,
    createdAt: '',
    updatedAt: '',
  });
}

/** A configuration as tests write it, with the contract's defaults left out */
export type ConfigInput = (typeof AutomationConfig)['_input'];

export function automationMeta(
  databaseId: string,
  name: string,
  config: ConfigInput,
  extra: Partial<AutomationMeta> = {},
): AutomationMeta {
  return {
    id: newId('automation'),
    databaseId,
    name,
    position: 0,
    enabled: false,
    config: AutomationConfig.parse(config),
    runAsId: null,
    stoppedBecause: null,
    webhookPath: null,
    lastRunAt: null,
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

/**
 * A database with Tasks (Name, Number, Email, Notes, Created, and a Signup form) and People (Name,
 * Email), opened in a session on the fake server.
 */
export async function automationFixture(options: FixtureOptions = {}): Promise<AutomationFixture> {
  const server = new FakeServer();
  const base = server.createDatabase(3);
  const database = server.database(base.databaseId);
  const { schema } = database;
  schema.database.role = options.role ?? 'owner';
  schema.tables[0]!.name = 'Tasks';
  const tasks = {
    id: base.tableId,
    viewId: base.viewId,
    formId: newId('view'),
    name: base.textFieldId,
    number: base.numberFieldId,
    email: newId('field'),
    notes: newId('field'),
    created: newId('field'),
    recordId: base.recordId,
  };
  const people = { id: newId('table'), viewId: newId('view'), name: newId('field'), email: newId('field') };
  schema.fields.push(
    field(tasks.id, tasks.email, 'Email', 'email', 2),
    field(tasks.id, tasks.notes, 'Notes', 'longText', 3),
    field(tasks.id, tasks.created, 'Created', 'createdTime', 4),
    field(people.id, people.name, 'Full name', 'text', 0),
    field(people.id, people.email, 'Work email', 'email', 1),
  );
  schema.tables.push({
    id: people.id,
    databaseId: base.databaseId,
    name: 'People',
    description: '',
    primaryFieldId: people.name,
    position: 1,
    createdAt: '',
    updatedAt: '',
  });
  const view = (id: string, tableId: string, name: string, type: 'grid' | 'form', position: number) => ({
    id,
    tableId,
    name,
    type,
    config: GridConfig.parse({}),
    position,
    createdBy: null,
    createdAt: '',
    updatedAt: '',
  });
  schema.views.push(
    view(tasks.formId, tasks.id, 'Signup', 'form', 1),
    view(people.viewId, people.id, 'Everyone', 'grid', 0),
  );
  database.records.set(people.id, new FakeRecords(people.id, { count: 0 }, ''));
  const ids = { databaseId: base.databaseId, tasks, people };
  schema.automations = (options.automations?.(ids) ?? []).map((automation, position) => ({
    ...automation,
    position,
  }));
  const session = await openDatabase(base.databaseId, server.deps());
  return { server, session, ...ids };
}

/** Sends the app's own requests (`api`) to the fake server, as the browser would. */
export function bridgeFetch(server: FakeServer) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const options: ApiOptions = {
      method: init?.method as ApiOptions['method'],
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    const headers = { 'content-type': 'application/json' };
    try {
      const answer = await server.http(input, options);
      return new Response(JSON.stringify(answer ?? null), { status: 200, headers });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return new Response(JSON.stringify({ error: error.info }), { status: error.status || 503, headers });
    }
  };
}

export const person: SessionInfo = {
  user: { id: 'usr00000000000001', name: 'Ada', email: 'ada@example.com', locale: 'en-US' },
  org: { id: 'org_test', name: 'Garden', settings: {} },
  membership: { kind: 'owner', adminRoles: [] },
  preferences: {},
  csrfToken: 'session-csrf',
};

export function renderWithProviders(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(sessionQuery.queryKey, person);
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const result = render(
    <I18nProvider i18n={i18n}>
      <LocaleProvider locale="en-US">
        <QueryClientProvider client={client}>
          <ConfirmProvider>{element}</ConfirmProvider>
          <ToastRegion />
        </QueryClientProvider>
      </LocaleProvider>
    </I18nProvider>,
  );
  return { ...result, client };
}

/** One automation's screen, following the session as it changes. */
export function ScreenHost({ session, automationId }: { session: DatabaseSession; automationId: string }) {
  const schema = useSchema(session);
  const automation = schema?.automationById.get(automationId);
  return schema && automation ? (
    <AutomationScreen session={session} schema={schema} automation={automation} />
  ) : null;
}

export function renderScreen(fixture: AutomationFixture, automationId: string) {
  return renderWithProviders(<ScreenHost session={fixture.session} automationId={automationId} />);
}

/** The configuration being edited, as the server holds it now: the draft, or the published one. */
export function savedConfig(fixture: AutomationFixture, automationId: string): AutomationConfig {
  const automation = fixture.server.database(fixture.databaseId).automation(automationId);
  return automation.draft?.config ?? automation.config;
}
