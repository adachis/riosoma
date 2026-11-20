import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  newId,
  type AiFieldEstimate,
  type AiFieldsStatus,
  type FieldMeta,
  type RowData,
} from '@riosoma/contracts';
import { ConfirmProvider } from '@riosoma/ui';
import type { GridApi } from '../../../../../packages/grid-core/src/types';
import { i18n } from '../../i18n';
import { createCellRenderer } from '../../grid/cells/renderers';
import { createHeaderRenderer } from '../../grid/cells/header';
import { GridMenu } from '../../grid/view/GridMenu';
import type { createGridController, GridState } from '../../grid/view/controller';
import type { SchemaState } from '../../data';
import { FieldDialog, type FieldDialogProps } from '../../screens/database/fields/FieldDialog';
import { field as makeField, selectOption } from '../../screens/database/fields/fieldTestUtils';
import { AiFieldStatusStore } from './status';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});

const tableId = newId('table');
const notes: FieldMeta = { ...makeField(), id: newId('field'), tableId, name: 'Notes' };
const summary: FieldMeta = {
  ...makeField(),
  id: newId('field'),
  tableId,
  name: 'Summary',
  ai: { prompt: `Summarize {${notes.id}}`, tier: 'fast', trigger: 'referencedChange', ownerId: null },
};
const schema = {
  fields: new Map([[tableId, [notes, summary]]]),
  fieldById: new Map([
    [notes.id, notes],
    [summary.id, summary],
  ]),
  tableById: new Map(),
} as unknown as SchemaState;

function status(partial: Partial<AiFieldsStatus>): AiFieldsStatus {
  return { unavailable: null, problems: [], cells: [], jobs: [], ...partial };
}

function withI18n(element: React.ReactElement) {
  const local = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  return render(
    <I18nProvider i18n={local}>
      <ConfirmProvider>{element}</ConfirmProvider>
    </I18nProvider>,
  );
}

function dialog(overrides: Partial<FieldDialogProps> = {}) {
  const props: FieldDialogProps = {
    mode: 'create',
    schema,
    tableId,
    existingNames: ['Notes', 'Summary'],
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    isSaving: false,
    ...overrides,
  };
  withI18n(<FieldDialog {...props} />);
  return props;
}

describe('the AI field settings', () => {
  it('makes an AI field with a prompt from field suggestions, an answer type, a tier, and a trigger', async () => {
    const { onSubmit } = dialog();
    await selectOption('Type', /^AI/);
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('AI');
    const prompt = screen.getByRole('textbox', { name: /Prompt/ });
    await userEvent.type(prompt, 'Count the ideas in {{No');
    await userEvent.click(screen.getByRole('option', { name: 'Notes' }));
    expect((prompt as HTMLTextAreaElement).value).toBe('Count the ideas in {Notes}');
    await selectOption('Answer type', 'Number');
    await selectOption('Model', 'Careful');
    await selectOption('Runs', 'Only when someone asks');
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'AI',
      description: '',
      spec: { type: 'number', options: { precision: null, thousands: true, allowNegative: true } },
      ai: { prompt: 'Count the ideas in {Notes}', tier: 'careful', trigger: 'onRequest' },
    });
  });

  it('refuses a prompt that names a field the table doesn’t have', async () => {
    const { onSubmit } = dialog();
    await selectOption('Type', /^AI/);
    await userEvent.type(screen.getByRole('textbox', { name: /Prompt/ }), 'Read {{Missing}');
    expect(screen.getByText('There’s no field named Missing in this table.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create field' }).hasAttribute('disabled')).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('offers no AI field, with the reason, when AI fields can’t run', async () => {
    dialog({ aiUnavailable: 'aiFields.noProvider' });
    await userEvent.click(screen.getByRole('button', { name: /Type/ }));
    const option = screen.getByRole('option', { name: /^AI/ });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toContain('AI fields need an AI provider.');
  });

  it('shows an AI field’s prompt with names, and turns it back into an ordinary field', async () => {
    const { onSubmit } = dialog({ mode: 'edit', initial: summary });
    expect((screen.getByRole('textbox', { name: /Prompt/ }) as HTMLTextAreaElement).value).toBe(
      'Summarize {Notes}',
    );
    await selectOption('Type', 'Text');
    expect(screen.queryByRole('textbox', { name: /Prompt/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ ai: null }));
  });
});

describe('where AI cells stand', () => {
  it('asks again while a run waits, and stops once nothing does', async () => {
    vi.useFakeTimers();
    const recordId = newId('record');
    const answers = [
      status({ cells: [{ fieldId: summary.id, recordId, state: 'pending', messageKey: null }] }),
      status({}),
    ];
    const fetchStatus = vi.fn(async () => answers.shift() ?? status({}));
    const store = new AiFieldStatusStore(tableId, fetchStatus);
    const changed = vi.fn();
    store.subscribe(changed);
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.cell(recordId, summary.id)?.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.cell(recordId, summary.id)).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    store.stop();
  });

  it('stops asking while runs can’t go, such as when they wait for next month’s budget', async () => {
    vi.useFakeTimers();
    const recordId = newId('record');
    const fetchStatus = vi.fn(async () =>
      status({
        unavailable: 'aiFields.paused',
        cells: [{ fieldId: summary.id, recordId, state: 'pending', messageKey: null }],
      }),
    );
    const store = new AiFieldStatusStore(tableId, fetchStatus);
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.cell(recordId, summary.id)?.state).toBe('pending');
    expect(store.problem(summary.id)).toBe('aiFields.paused');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    // A change to the records still asks again.
    store.nudge();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    store.stop();
  });

  it('draws a waiting cell, a failed cell with its reason, and a bulk run’s progress in the header', async () => {
    const waiting = newId('record');
    const failed = newId('record');
    const store = new AiFieldStatusStore(tableId, async () =>
      status({
        cells: [
          { fieldId: summary.id, recordId: waiting, state: 'pending', messageKey: null },
          {
            fieldId: summary.id,
            recordId: failed,
            state: 'error',
            messageKey: 'aiFields.output.notChoice',
            params: { answer: 'Mineral' },
          },
        ],
        jobs: [
          {
            id: 'job1',
            fieldId: summary.id,
            scope: 'all',
            state: 'running',
            total: 40,
            done: 11,
            failed: 1,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    await store.refresh();
    const fieldsById = new Map([[summary.id, summary]]);
    const render = createCellRenderer({
      fieldsById,
      format: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
      rowHeight: 'short',
      aiFields: store,
    });
    const draw = (id: string) => {
      const cell = document.createElement('div');
      cell.setAttribute('role', 'gridcell');
      const content = document.createElement('div');
      cell.append(content);
      const row = { id, values: { [summary.id]: 'Old' } } as unknown as RowData;
      render(content, {
        row,
        rowIndex: 0,
        column: { id: summary.id, width: 200, edit: 'inline' },
        colIndex: 0,
        selected: false,
        active: false,
      });
      return cell;
    };
    const pending = draw(waiting);
    expect(pending.classList.contains('rio-cell-ai--pending')).toBe(true);
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(pending.title).toBe('Generating…');
    const error = draw(failed);
    expect(error.classList.contains('rio-cell-ai--error')).toBe(true);
    expect(error.title).toBe('The model answered “Mineral”, which isn’t one of this field’s options.');
    expect(error.textContent).toBe('Old');
    const header = document.createElement('div');
    createHeaderRenderer({
      fieldsById,
      primaryFieldId: notes.id,
      aiFields: store,
      t: i18n._.bind(i18n),
    })(header, { id: summary.id, width: 200, edit: 'inline' }, 0);
    expect(header.querySelector('[role="progressbar"]')?.textContent).toBe('12 of 40');
  });
});

describe('generating from the field’s menu', () => {
  it('shows the estimate and asks before generating more than 25 values', async () => {
    const estimate: AiFieldEstimate = {
      records: 30,
      providerId: 'remote',
      model: 'small-model',
      tokens: { low: 1_200, high: 4_800 },
      costUsd: { low: 0.01, high: 0.04 },
      footprint: {
        energyWh: { min: 0.36, max: 2.4 },
        gwpG: { min: 0.18, max: 1.2 },
        method: 'EcoLogits 0.11.1',
        zone: 'WOR',
      },
      needsConfirmation: true,
    };
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/ai/estimate')) return new Response(JSON.stringify(estimate), { status: 200 });
      if (url.endsWith('/ai/generate'))
        return new Response(JSON.stringify({ queued: 30, job: null }), { status: 200 });
      return new Response(JSON.stringify(status({})), { status: init ? 200 : 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    const store = new AiFieldStatusStore(tableId, async () => status({}));
    const state = {
      session: { role: () => 'editor', run: vi.fn() },
      rows: { rowCount: () => 30, getRow: () => undefined },
      table: { id: tableId, primaryFieldId: notes.id },
      view: { config: { sorts: [], filter: null, hiddenFieldIds: [], summaries: {} } },
      fields: [notes, summary],
      aiFields: store,
      onConfig: vi.fn(),
      onField: vi.fn(),
    } as unknown as GridState;
    const controller = { columns: () => [{ id: notes.id }, { id: summary.id }] } as unknown as ReturnType<
      typeof createGridController
    >;
    const grid = {
      getSelection: () => ({ active: null, range: null, rows: { kind: 'none' } }),
    } as unknown as GridApi<RowData>;
    withI18n(
      <GridMenu
        state={state}
        target={{ kind: 'header', col: 1 }}
        point={{ x: 0, y: 0 }}
        grid={grid}
        controller={controller}
        signal={new AbortController().signal}
        onClose={vi.fn()}
        onFilter={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Generate for all records' }));
    const confirm = await screen.findByRole('dialog', { name: 'Generate 30 values?' });
    expect(confirm.textContent).toContain('Generate 30 values?');
    expect(confirm.textContent).toContain(
      'small-model · about 1,200–4,800 tokens · $0.01–$0.04 · estimate: about 0.36 to 2.4 Wh and 0.18 to 1.2 g CO2e',
    );
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/ai/generate'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Generate 30 values' }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/ai/generate'))).toBe(true),
    );
    const request = fetcher.mock.calls.find(([url]) => String(url).endsWith('/ai/generate'))!;
    expect(JSON.parse(String(request[1]!.body))).toEqual({ scope: 'all', confirmed: true });
  });
});
