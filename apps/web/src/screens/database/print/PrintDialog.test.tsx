import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import type { Content, ContentTable, TDocumentDefinitions } from 'pdfmake/interfaces';
import { renderShell } from '../shell/test-support';
import { RecordCard } from '../record/RecordCard';
import { PRINT_PAGE } from './load';
import { PrintDialog } from './PrintDialog';
import { PrintViewDialog } from './PrintViewDialog';
import {
  allFields,
  APOLLO,
  fields,
  format,
  SKYLAB,
  manyRecords,
  page,
  record,
  rows,
  table,
  view,
  VIEW_ID,
  type ConfigInput,
} from './testing';

/** The PDF library is swapped for a recorder, so these tests read the document the dialog made. */
const output = vi.hoisted(() => {
  const made: TDocumentDefinitions[] = [];
  return {
    made,
    pdfBlob: vi.fn(async (definition: TDocumentDefinitions) => {
      made.push(definition);
      return new Blob(['%PDF-'], { type: 'application/pdf' });
    }),
    printBlob: vi.fn(async (_blob: Blob) => {}),
  };
});
vi.mock('./output', () => ({ pdfBlob: output.pdfBlob, printBlob: output.printBlob }));

/** Copy with the app's two spaces after a period, which a text query normalizes to one. */
const STOPPED = /Stopped\.\s+No PDF was made\./;
const FAILED = /The PDF didn’t work\.\s+Try again\./;

let saved: string[] = [];
beforeEach(() => {
  saved = [];
  output.made.length = 0;
  output.pdfBlob.mockClear();
  output.printBlob.mockReset();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:print');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
});

afterEach(() => {
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Answers the rows API from a function of the page asked for, recording each request. */
function rowsApi(answer: (offset: number, signal: AbortSignal) => Promise<Response> | Response) {
  const asked: number[] = [];
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    expect(url.pathname).toBe(`/api/views/${VIEW_ID}/rows`);
    const offset = Number(url.searchParams.get('offset'));
    asked.push(offset);
    return answer(offset, init.signal!);
  });
  vi.stubGlobal('fetch', fetch);
  return asked;
}

/** A view of `total` numbered records, served a page at a time. */
function serve(total: number) {
  return rowsApi((offset) =>
    json(page(offset, manyRecords(offset + 1, Math.min(PRINT_PAGE, total - offset)), total)),
  );
}

function openView(type: 'grid' | 'gallery' | 'kanban' = 'grid', config: ConfigInput = {}) {
  const onClose = vi.fn();
  renderShell(
    <>
      <PrintViewDialog
        databaseName="Operations"
        table={table}
        view={view(type, config)}
        fields={allFields}
        format={format()}
        onClose={onClose}
      />
      <ToastRegion />
    </>,
  );
  return { onClose, dialog: screen.getByRole('dialog', { name: 'Print or save as PDF' }) };
}

const lastDocument = () => output.made.at(-1)!;
const headerRow = (definition: TDocumentDefinitions) =>
  ((definition.content as Content[])[2] as ContentTable).table.body[0]!.map(
    (cell) => (cell as { text: string }).text,
  );

describe('printing a view', () => {
  it('starts from the view: its name, the reader’s paper, and the fields the view shows', async () => {
    openView('grid', { hiddenFieldIds: [fields.budget.id] });
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveProperty('value', 'Launch board');
    expect(screen.getByRole('radio', { name: 'Letter' })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: 'Landscape' })).toHaveProperty('checked', true);
    expect(
      screen.getByRole('listbox', {
        name: 'Fields',
        description: 'Starts with the fields the view shows, in its order.',
      }),
    ).toBeTruthy();
    const name = screen.getByRole('option', { name: /^Name/ });
    expect(name.getAttribute('aria-selected')).toBe('true');
    expect(name.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: 'Status' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: 'Budget' }).getAttribute('aria-selected')).toBe('false');
    // Hidden fields stay in the view's order, ready to be chosen again.
    expect(
      screen.getAllByRole('option').map((box) => box.textContent?.replace('Always included', '')),
    ).toEqual(allFields.map((item) => item.name));
    cleanup();
    openView('gallery');
    expect(screen.getByRole('radio', { name: 'Portrait' })).toHaveProperty('checked', true);
  });

  it('reads the records a page at a time with progress, then saves the PDF', async () => {
    const total = PRINT_PAGE + 100;
    let release: () => void = () => {};
    const second = new Promise<void>((resolve) => {
      release = resolve;
    });
    const asked = rowsApi(async (offset) => {
      if (offset > 0) await second;
      return json(page(offset, manyRecords(offset + 1, Math.min(PRINT_PAGE, total - offset)), total));
    });
    const { onClose } = openView();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save PDF' }));
    const progress = await screen.findByRole('progressbar', { name: 'Loading records' });
    await waitFor(() => expect(progress.getAttribute('aria-valuetext')).toBe('500 of 600'));
    // The button that was pressed is gone, so the keyboard lands on Stop.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop' })));
    release();
    await waitFor(() => expect(saved).toEqual(['Tasks - Launch board.pdf']));
    expect(asked).toEqual([0, PRINT_PAGE]);
    expect(onClose).toHaveBeenCalledOnce();
    const definition = lastDocument();
    expect(((definition.content as Content[])[2] as ContentTable).table.body).toHaveLength(total + 1);
    expect(definition.pageOrientation).toBe('landscape');
    expect(definition.pageSize).toBe('LETTER');
  });

  it('prints only the fields chosen, under the title typed, on the paper picked', async () => {
    serve(3);
    openView('grid', { hiddenFieldIds: [fields.budget.id] });
    const user = userEvent.setup();
    await user.click(screen.getByRole('option', { name: 'Status' }));
    await user.click(screen.getByRole('option', { name: 'Budget' }));
    await user.click(screen.getByRole('radio', { name: 'A4' }));
    await user.click(screen.getByRole('radio', { name: 'Portrait' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Q3 review');
    await user.click(screen.getByRole('button', { name: 'Save PDF' }));
    await waitFor(() => expect(saved).toEqual(['Tasks - Q3 review.pdf']));
    const definition = lastDocument();
    expect(headerRow(definition)).toEqual(
      allFields.map((item) => item.name).filter((item) => item !== 'Status'),
    );
    expect((definition.content as Content[])[0]).toMatchObject({ text: 'Q3 review' });
    expect(definition.pageSize).toBe('A4');
    expect(definition.pageOrientation).toBe('portrait');
  });

  it('stops a read on request, and makes nothing', async () => {
    let aborted = false;
    rowsApi(
      (_offset, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Stopped', 'AbortError'));
          });
        }),
    );
    const { onClose } = openView();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save PDF' }));
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText(STOPPED)).toBeDefined();
    expect(aborted).toBe(true);
    expect(output.pdfBlob).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    // The choices are still there, ready to go again.
    expect(screen.getByRole('button', { name: 'Save PDF' })).toHaveProperty('disabled', false);
  });

  it('asks before making a PDF of more than 5,000 records', async () => {
    const total = 6_000;
    const asked = serve(total);
    openView('gallery');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save PDF' }));
    expect(await screen.findByText(/This view has 6,000 records\./)).toBeDefined();
    expect(asked).toEqual([0]);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText(STOPPED)).toBeDefined();
    expect(asked).toEqual([0]);
    // Going ahead reads every page, asking only the once.
    await user.click(screen.getByRole('button', { name: 'Save PDF' }));
    const going = await screen.findByRole('button', { name: 'Continue' });
    await waitFor(() => expect(document.activeElement).toBe(going));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(saved).toEqual(['Tasks - Launch board.pdf']));
    expect(asked).toHaveLength(1 + total / PRINT_PAGE);
    expect(output.made).toHaveLength(1);
  });

  it('opens the same PDF in the print dialog, and saves it when the browser won’t print', async () => {
    serve(3);
    const { onClose } = openView('kanban', { kanban: { stackFieldId: fields.status.id } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(output.printBlob).toHaveBeenCalledOnce();
    expect(output.printBlob.mock.calls[0]![0]).toBeInstanceOf(Blob);
    expect(saved).toEqual([]);
    expect(JSON.stringify(lastDocument().content)).toContain('"style":"stack"');
    cleanup();
    output.printBlob.mockRejectedValueOnce(new Error('Blocked'));
    const second = openView();
    await user.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(saved).toEqual(['Tasks - Launch board.pdf']));
    expect(second.onClose).toHaveBeenCalledOnce();
    const notices = screen.getByRole('region', { name: 'Notifications' });
    expect(within(notices).getByText(/didn’t open its print dialog/)).toBeDefined();
  });

  it('says why the PDF couldn’t be made', async () => {
    rowsApi(() =>
      json({ error: { code: 'not_found', messageKey: 'errors.notFound', userFault: true } }, 404),
    );
    const { onClose } = openView();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save PDF' }));
    expect(await screen.findByText(FAILED)).toBeDefined();
    expect(screen.getByText('That page or item doesn’t exist.')).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it('closes with Cancel and never reads a thing', async () => {
    const asked = serve(3);
    const { onClose } = openView();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(asked).toEqual([]);
  });
});

describe('printing a record from its card', () => {
  function openCard(values = rows[0]!) {
    renderShell(
      <RecordCard
        fields={[fields.status, fields.name, fields.projects, fields.files, fields.approval]}
        primaryFieldId={table.primaryFieldId}
        row={values}
        format={format()}
        readOnly
        canEditOptions={false}
        position={null}
        onChange={() => {}}
        onAddOption={() => ''}
        onClose={() => {}}
      />,
    );
  }

  it('offers printing in the card’s menu and prints the record’s fields as labels and values', async () => {
    const fetch = vi.fn(async (path: string) =>
      path.includes('/records/names') ? json({ [SKYLAB]: 'Skylab' }) : json({}),
    );
    vi.stubGlobal('fetch', fetch);
    openCard(record(1, { name: 'Launch plan', projects: [APOLLO, SKYLAB] }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More for this record' }));
    await user.click(screen.getByRole('menuitem', { name: 'Print or save as PDF' }));
    const dialog = await screen.findByRole('dialog', { name: 'Print or save as PDF' });
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveProperty('value', 'Launch plan');
    expect(within(dialog).getByRole('radio', { name: 'Portrait' })).toHaveProperty('checked', true);
    expect(
      within(dialog)
        .getAllByRole('checkbox')
        .every((box) => (box as HTMLInputElement).checked),
    ).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Save PDF' }));
    await waitFor(() => expect(saved).toEqual(['Launch plan.pdf']));
    const [title, list] = lastDocument().content as [Content, ContentTable];
    expect(title).toMatchObject({ text: 'Launch plan' });
    // The primary field leads, then the card's order.
    expect(list.table.body.map((row) => (row[0] as { text: string }).text)).toEqual([
      'Name',
      'Status',
      'Projects',
      'Files',
      'Approval',
    ]);
    // A linked record the session hadn't named yet is asked for, so it prints by name.
    expect(JSON.stringify(list.table.body[2])).toContain('Skylab');
    expect(JSON.stringify(list.table.body[2])).toContain('Apollo');
    expect(fetch).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Print or save as PDF' })).toBeNull());
  });

  it('keeps the menu off a card whose record is still loading', () => {
    renderShell(
      <RecordCard
        fields={[fields.name]}
        primaryFieldId={table.primaryFieldId}
        row={null}
        format={format()}
        readOnly
        canEditOptions={false}
        position={null}
        onChange={() => {}}
        onAddOption={() => ''}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'More for this record' })).toBeNull();
  });
});

it('keeps short print choices as labeled checkboxes with their help', async () => {
  renderShell(
    <PrintDialog
      kind="record"
      defaultTitle="Record"
      defaultOrientation="portrait"
      choices={[fields.name, fields.status].map((field) => ({ field, chosen: true }))}
      primaryFieldId={fields.name.id}
      fileName={(title) => title}
      make={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const group = screen.getByRole('group', {
    name: 'Fields',
    description: 'Starts with every field on the card.',
  });
  const status = within(group).getByRole('checkbox', { name: 'Status' }) as HTMLInputElement;
  expect(status.checked).toBe(true);
  await userEvent.click(status);
  expect(status.checked).toBe(false);
  expect((within(group).getByRole('checkbox', { name: /^Name/ }) as HTMLInputElement).disabled).toBe(true);
});
