import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { newId, type PlatformImport } from '@riosoma/contracts';
import { DatabaseSettingsMenu } from '../../database/webhooks/WebhooksDialog';
import { showReportWhenOpened } from '../airtable/pending';
import { platformLine, reportTitle, usePlatformReport } from './PlatformReport';

const DATABASE = newId('database');

const imported: PlatformImport = {
  id: `job${'G'.repeat(14)}`,
  platform: 'grist',
  address: 'https://docs.example.com',
  baseId: 'doc1',
  name: 'Budget',
  databaseId: DATABASE,
  state: 'finished',
  progress: { phase: null, tables: 1, tablesDone: 1, records: 3, files: 0, table: null },
  version: 4,
  error: null,
  report: {
    tables: 1,
    fields: 4,
    records: 3,
    views: 1,
    files: 0,
    items: [
      {
        status: 'changed',
        subject: 'field',
        table: 'Projects',
        name: 'Hours',
        messageKey: 'import.platform.report.formulaRelation',
        params: { type: 'rollup', formula: 'SUM(Tasks.lookupRecords(Project=$id).Hours)' },
      },
      {
        status: 'omitted',
        subject: 'base',
        table: null,
        name: null,
        messageKey: 'import.platform.report.notShared',
        params: {},
      },
      {
        status: 'exact',
        subject: 'field',
        table: 'Projects',
        name: 'Name',
        messageKey: 'import.platform.report.exact',
        params: {},
      },
    ],
  },
  createdAt: '2026-09-28T12:00:00.000Z',
  finishedAt: '2026-09-28T12:01:00.000Z',
};

beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ imports: [imported] }), {
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </I18nProvider>
  );
}

describe('the report of an import from another tool', () => {
  it('reads each line with the tool’s name', () => {
    const line = platformLine('grist');
    expect(line(i18n, imported.report!.items[1]!)).toBe(
      'Comments, revision history, automations, webhooks, row colors, and sharing settings stay in Grist.',
    );
    expect(line(i18n, imported.report!.items[0]!)).toBe(
      'Became a rollup here, which gives the same results as the formula.',
    );
    expect(reportTitle(i18n, 'baserow')).toBe('Baserow import report');
  });

  it('opens with the database right after the import, and stays in its settings menu', async () => {
    showReportWhenOpened(DATABASE);
    const { result } = renderHook(() => usePlatformReport(DATABASE, true), { wrapper });
    await waitFor(() => expect(result.current.platform).toBe('grist'));
    render(<>{result.current.dialog}</>, { wrapper });
    const dialog = await screen.findByRole('dialog', { name: 'Grist import report' });
    expect(within(dialog).getByText('1 table, 3 records, 1 view, and 0 files came across.')).toBeDefined();
    expect(within(dialog).getByText('SUM(Tasks.lookupRecords(Project=$id).Hours)')).toBeDefined();
    cleanup();

    const user = userEvent.setup();
    const open = vi.fn();
    render(
      <DatabaseSettingsMenu
        databaseId="dbs_report"
        onWebhooks={vi.fn()}
        platformReport={{ label: reportTitle(i18n, 'grist'), open }}
      />,
      { wrapper },
    );
    await user.click(screen.getByRole('button', { name: 'Database settings' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Grist import report' }));
    expect(open).toHaveBeenCalledOnce();
  });
});
