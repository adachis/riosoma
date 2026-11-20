import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlAccess, SqlResult } from '@riosoma/contracts';
import { api } from '../../../api';
import type * as ApiModule from '../../../api';
import { SqlScreen } from './SqlScreen';

vi.mock('../../../api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const access: SqlAccess = {
  allowed: true,
  admin: false,
  settings: { roles: ['owner'], timeoutMs: 15000, rowCap: 10000 },
  tables: [{ id: 'table', name: 'People', fields: [{ id: 'field', name: 'Name' }] }],
};
function show(state = access) {
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SqlScreen databaseId="base" access={state} people={[]} refresh={() => undefined} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}
describe('SQL screen', () => {
  it('completes visible names and renders read-only results with paging and personal history', async () => {
    const result: SqlResult = {
      id: crypto.randomUUID(),
      columns: ['Name'],
      rows: [['Ana']],
      rowCount: 101,
      durationMs: 2,
      capped: false,
    };
    vi.mocked(api).mockImplementation(async (path) =>
      path.endsWith('/history')
        ? [{ id: 'old', query: 'SELECT 1' }]
        : path.includes('offset=100')
          ? { ...result, rows: [['Zed']] }
          : result,
    );
    show();
    const field = screen.getByRole('textbox', { name: 'SQL query' });
    await userEvent.type(field, 'SELECT * FROM Pe');
    await userEvent.click(await screen.findByRole('button', { name: '"People"' }));
    expect((field as HTMLTextAreaElement).value).toBe('SELECT * FROM "People"');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('cell', { name: 'Ana' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Ana' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByRole('cell', { name: 'Zed' })).toBeTruthy();
    fireEvent.click(screen.getByText('Recent queries'));
    await userEvent.click(await screen.findByRole('button', { name: 'SELECT 1' }));
    expect((field as HTMLTextAreaElement).value).toBe('SELECT 1');
  });
  it('sends cancellation for the active run', async () => {
    let finish: ((value: SqlResult) => void) | undefined;
    vi.mocked(api).mockImplementation(async (path) =>
      path.endsWith('/run')
        ? new Promise<SqlResult>((resolve) => {
            finish = resolve;
          })
        : [],
    );
    show();
    fireEvent.change(screen.getByRole('textbox', { name: 'SQL query' }), { target: { value: 'SELECT 1' } });
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith('/cancel'))).toBe(true),
    );
    finish?.({ id: crypto.randomUUID(), columns: [], rows: [], rowCount: 0, durationMs: 0, capped: false });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false),
    );
  });
  it('shows admins the SQL that adds a query role when queries run without one', async () => {
    vi.mocked(api).mockImplementation(async (path) =>
      path.endsWith('/login')
        ? { enabled: false, ready: false, personId: null, role: 'rio_read_x', schema: 'rio_sql_x' }
        : [],
    );
    const sql = 'CREATE ROLE "rio_query_x" NOLOGIN;';
    show({ ...access, admin: true, queryRole: { role: 'rio_query_x', active: false, sql } });
    fireEvent.click(screen.getByText('SQL administration'));
    expect(await screen.findByText(/a database administrator can run this SQL/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Query role SQL' }) as HTMLTextAreaElement).value).toBe(sql);
    cleanup();
    show({ ...access, admin: true, queryRole: { role: 'rio_query_x', active: true, sql: null } });
    fireEvent.click(screen.getByText('SQL administration'));
    expect(screen.queryByText(/a database administrator can run this SQL/)).toBeNull();
  });
  it('keeps the editor unavailable to disallowed roles', () => {
    vi.mocked(api).mockResolvedValue([]);
    show({ ...access, allowed: false });
    expect(screen.queryByRole('textbox', { name: 'SQL query' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
  });
  it('explains PUBLIC schema creation for both pending setups and annotates their administrator SQL', async () => {
    const sql = 'BEGIN;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\nCOMMIT;';
    vi.mocked(api).mockImplementation(async (path) =>
      path.endsWith('/login')
        ? {
            enabled: true,
            ready: false,
            personId: 'person',
            role: 'rio_read_x',
            schema: 'rio_sql_x',
            reason: 'sql.setup.publicCreate',
            sql,
          }
        : [],
    );
    show({
      ...access,
      admin: true,
      queryRole: { role: 'rio_query_x', active: false, reason: 'sql.setup.publicCreate', sql },
    });
    fireEvent.click(screen.getByText('SQL administration'));
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(2));
    for (const status of screen.getAllByRole('status')) {
      expect(status.textContent).toContain('PUBLIC can create objects in the public schema');
      expect(status.textContent).toContain('application account cannot revoke');
    }
    for (const label of ['Query role SQL', 'Administrator SQL']) {
      expect((screen.getByRole('textbox', { name: label }) as HTMLTextAreaElement).value).toBe(
        `-- Remove the CREATE privilege that every role inherits through PUBLIC.\n${sql}`,
      );
    }
  });
  it('says what an outside login can see of other databases, once the server allows outside logins', async () => {
    const login = { enabled: false, ready: false, personId: null, role: 'rio_read_x', schema: 'rio_sql_x' };
    const shared = /every organization on this server shares/;
    vi.mocked(api).mockImplementation(async (path) => (path.endsWith('/login') ? login : []));
    show({ ...access, admin: true });
    fireEvent.click(screen.getByText('SQL administration'));
    expect(await screen.findByText(shared)).toBeTruthy();
    cleanup();
    vi.mocked(api).mockImplementation(async (path) =>
      path.endsWith('/login') ? { ...login, reason: 'sql.setup.outsideLogins' } : [],
    );
    show({ ...access, admin: true });
    fireEvent.click(screen.getByText('SQL administration'));
    expect(await screen.findByText(/Logins for outside tools are off on this server/)).toBeTruthy();
    expect(screen.queryByText(shared)).toBeNull();
  });
});
