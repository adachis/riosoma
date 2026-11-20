import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GridConfig } from '@riosoma/contracts';
import { recordDocument, viewDocument } from './document';
import { pdfBlob, printBlob } from './output';
import { allFields, context, field, rows, settings, table } from './testing';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function start(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new TextDecoder().decode(bytes.slice(0, 5));
}

describe('making the PDF', () => {
  it('turns a view and a record into real PDF files', async () => {
    const view = viewDocument(
      rows,
      settings(),
      {
        type: 'grid',
        config: GridConfig.parse({}),
        primaryFieldId: table.primaryFieldId,
        tableFields: allFields,
      },
      context(),
    );
    const blob = await pdfBlob(view);
    expect(blob.type).toBe('application/pdf');
    expect(await start(blob)).toBe('%PDF-');
    expect(await start(await pdfBlob(recordDocument(rows[0]!, settings(), context())))).toBe('%PDF-');
  });
});

it('prints org chart cards and connectors across readable PDF pages', async () => {
  const parent = field('Parent', 'link', 100, { linkedTableId: table.id });
  const linked = rows.map((row, index) => ({
    ...row,
    values: { ...row.values, [parent.id]: index ? [rows[index - 1]!.id] : [] },
  }));
  const document = viewDocument(
    linked,
    settings(),
    {
      type: 'orgChart',
      config: GridConfig.parse({ orgChart: { parentFieldId: parent.id } }),
      primaryFieldId: table.primaryFieldId,
      tableFields: [...allFields, parent],
    },
    context(),
  );
  expect(JSON.stringify(document.content)).toContain('<path');
  expect(JSON.stringify(document.content)).toContain('<rect');
  expect(await start(await pdfBlob(document))).toBe('%PDF-');
});

describe('printing the PDF', () => {
  /** Where each frame was pointed.  The DOM emulator can't open a PDF, so it never tries to. */
  const sources = new WeakMap<HTMLIFrameElement, string>();
  beforeEach(() => {
    vi.spyOn(HTMLIFrameElement.prototype, 'src', 'set').mockImplementation(function (
      this: HTMLIFrameElement,
      value: string,
    ) {
      sources.set(this, value);
    });
  });

  function frames() {
    return [...document.querySelectorAll<HTMLIFrameElement>('iframe.rio-print-frame')];
  }

  function loaded(frame: HTMLIFrameElement) {
    const view = { focus: vi.fn(), print: vi.fn() };
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: view });
    frame.dispatchEvent(new Event('load'));
    return view;
  }

  it('opens the browser’s print dialog from a frame nobody sees', async () => {
    const urls = ['blob:first', 'blob:second'];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => urls.shift() ?? 'blob:more');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const printing = printBlob(new Blob(['%PDF-'], { type: 'application/pdf' }));
    const [frame] = frames();
    expect(sources.get(frame!)).toBe('blob:first');
    expect(frame?.getAttribute('aria-hidden')).toBe('true');
    expect(frame?.tabIndex).toBe(-1);
    const view = loaded(frame!);
    await printing;
    expect(view.focus).toHaveBeenCalledOnce();
    expect(view.print).toHaveBeenCalledOnce();
    // The next printout takes the last one's place, and lets its file go.
    const next = printBlob(new Blob(['%PDF-'], { type: 'application/pdf' }));
    expect(frames().map((item) => sources.get(item))).toEqual(['blob:second']);
    expect(revoke).toHaveBeenCalledWith('blob:first');
    loaded(frames()[0]!);
    await next;
  });

  it('says so when the browser won’t print from the frame', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:refused');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const printing = printBlob(new Blob(['%PDF-'], { type: 'application/pdf' }));
    const [frame] = frames();
    Object.defineProperty(frame!, 'contentWindow', {
      configurable: true,
      value: {
        focus: vi.fn(),
        print: () => {
          throw new DOMException('Blocked', 'SecurityError');
        },
      },
    });
    frame!.dispatchEvent(new Event('load'));
    await expect(printing).rejects.toThrow('Blocked');
  });
});
