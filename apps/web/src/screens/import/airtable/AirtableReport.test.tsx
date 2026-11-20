import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { newId, type AirtableImport, type AirtableReport } from '@riosoma/contracts';
import { DatabaseSettingsMenu } from '../../database/webhooks/WebhooksDialog';
import { AirtableReportView, reportLine, useAirtableReport } from './AirtableReport';
import { showReportWhenOpened } from './pending';

const report: AirtableReport = {
  tables: 2,
  fields: 5,
  records: 3,
  views: 2,
  files: 0,
  items: [
    {
      status: 'omitted',
      subject: 'field',
      table: 'Projects',
      name: 'Future',
      messageKey: 'import.airtable.report.typeUnsupported',
      params: { type: 'someNewType' },
    },
    {
      status: 'changed',
      subject: 'field',
      table: 'Projects',
      name: 'Hours',
      messageKey: 'import.airtable.report.rollupMatched',
      params: { fn: 'sum', count: 2 },
    },
    {
      status: 'changed',
      subject: 'field',
      table: 'Projects',
      name: 'Total',
      messageKey: 'import.airtable.report.formulaText',
      params: { formula: 'LEFT({Budget}, 2)' },
      detail: { messageKey: 'formula.type.argument', params: {} },
    },
    {
      status: 'exact',
      subject: 'records',
      table: 'Projects',
      name: null,
      messageKey: 'import.airtable.report.records',
      params: { count: 3 },
    },
    ...['Name', 'Status', 'Budget'].map((name) => ({
      status: 'exact' as const,
      subject: 'field' as const,
      table: 'Projects',
      name,
      messageKey: 'import.airtable.report.exact',
      params: {},
    })),
    {
      status: 'exact',
      subject: 'view',
      table: 'Projects',
      name: 'Grid view',
      messageKey: 'import.airtable.report.exact',
      params: {},
    },
    {
      status: 'omitted',
      subject: 'base',
      table: null,
      name: null,
      messageKey: 'import.airtable.report.notShared',
      params: {},
    },
  ],
};

const DATABASE = newId('database');
const imported: AirtableImport = {
  id: `job${'B'.repeat(14)}`,
  baseId: `app${'L'.repeat(14)}`,
  name: 'Launch plan',
  databaseId: DATABASE,
  state: 'finished',
  progress: { phase: null, tables: 2, tablesDone: 2, records: 3, files: 0, table: null },
  version: 9,
  error: null,
  report,
  createdAt: '2026-09-27T12:00:00.000Z',
  finishedAt: '2026-09-27T12:05:00.000Z',
};

beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>{element}</QueryClientProvider>
    </I18nProvider>,
  );
}

describe('the Airtable import report', () => {
  it('shows what was left out and what changed, with why, and what came across exactly by table', async () => {
    const user = userEvent.setup();
    mount(<AirtableReportView report={report} />);
    expect(screen.getByText('2 tables, 3 records, 2 views, and 0 files came across.')).toBeDefined();
    const omitted = screen.getByRole('button', { name: 'Left out (2)' });
    expect(omitted.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Projects › Future')).toBeDefined();
    expect(screen.getByText('Left out, since Riosoma has no field like this (someNewType).')).toBeDefined();
    expect(
      screen.getByText(
        'Record comments, revision history, automations, interfaces, and extensions stay in Airtable.',
      ),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Changed (2)' }).getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByText(
        'Airtable doesn’t share rollup formulas, so this one uses Sum, which gives the same values.',
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        'Kept as text, since the formula doesn’t work here.  This argument has the wrong value type.',
        {
          normalizer: (text) => text,
        },
      ),
    ).toBeDefined();
    expect(screen.getByText('LEFT({Budget}, 2)').tagName).toBe('CODE');
    const exact = screen.getByRole('button', { name: 'Came across exactly (5)' });
    expect(exact.getAttribute('aria-expanded')).toBe('false');
    await user.click(exact);
    const projects = screen.getByRole('region', { name: 'Projects' });
    expect(within(projects).getByText('3 records came across.')).toBeDefined();
    expect(within(projects).getByText('Fields: Name, Status, and Budget')).toBeDefined();
    expect(within(projects).getByText('Views: Grid view')).toBeDefined();
  });

  it('reads a line it doesn’t know yet as a change', () => {
    expect(
      reportLine(i18n, {
        status: 'changed',
        subject: 'field',
        table: 'T',
        name: 'F',
        messageKey: 'import.airtable.report.somethingNew',
        params: {},
      }),
    ).toBe('Came across with a change.');
  });
});

describe('the report kept with a database', () => {
  function Harness({ enabled = true }: { enabled?: boolean }) {
    const kept = useAirtableReport(DATABASE, enabled);
    return (
      <>
        <DatabaseSettingsMenu
          databaseId={DATABASE}
          onWebhooks={vi.fn()}
          {...(kept.available ? { onImportReport: kept.open } : {})}
        />
        {kept.dialog}
      </>
    );
  }

  function serve(imports: AirtableImport[]) {
    const fetch = vi.fn(async (path: string) => {
      if (path === `/api/databases/${DATABASE}/imports/airtable`)
        return new Response(JSON.stringify({ imports }), { headers: { 'content-type': 'application/json' } });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('opens from the database’s settings menu', async () => {
    const user = userEvent.setup();
    serve([imported]);
    mount(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Database settings' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Airtable import report' }));
    const dialog = await screen.findByRole('dialog', { name: 'Airtable import report' });
    expect(within(dialog).getByText('Projects › Future')).toBeDefined();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens by itself right after the import that made the database', async () => {
    serve([imported]);
    showReportWhenOpened(DATABASE);
    mount(<Harness />);
    expect(await screen.findByRole('dialog', { name: 'Airtable import report' })).toBeDefined();
  });

  it('isn’t in the menu for a database that didn’t come from Airtable, or for people who can’t edit it', async () => {
    const user = userEvent.setup();
    const fetch = serve([]);
    mount(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Database settings' }));
    await screen.findByRole('menuitem', { name: 'Webhooks' });
    expect(screen.queryByRole('menuitem', { name: 'Airtable import report' })).toBeNull();
    await user.keyboard('{Escape}');
    cleanup();
    fetch.mockClear();
    mount(<Harness enabled={false} />);
    await screen.findByRole('button', { name: 'Database settings' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
