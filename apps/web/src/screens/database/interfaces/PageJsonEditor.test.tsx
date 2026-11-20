import { i18n } from '@lingui/core';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Window as TestWindow } from 'happy-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSession } from '../../../data/types';
import { parsePageJson } from './page-json';
import { closeAll, everyBlock, PAGE_ID } from './test-support';
import { openInterface } from './testing';

const sessions: DatabaseSession[] = [];
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  // Component tests have no HTTP server, so provide the frame's empty document locally.
  (window as unknown as TestWindow).happyDOM.settings.fetch.interceptor = {
    beforeAsyncRequest: async ({ request, window: frame }) => {
      if (new URL(request.url).pathname === '/api/interfaces/code-frame')
        return new frame.Response('<!doctype html><html><body></body></html>', {
          headers: { 'content-type': 'text/html' },
        });
    },
  };
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
  (window as unknown as TestWindow).happyDOM.settings.fetch.interceptor = null;
});

describe('page JSON editor', () => {
  it('keeps the page JSON action outlined when editing an interface', async () => {
    await openInterface(sessions);
    await userEvent.click(screen.getByRole('button', { name: 'Edit interface' }));
    expect(screen.getByRole('button', { name: 'Edit page JSON' }).getAttribute('data-variant')).toBe(
      'secondary',
    );
  });

  it.each(['title', 'place'] as const)('preserves the code frame when its %s changes', async (property) => {
    const code = {
      id: 'custom01',
      kind: 'code' as const,
      title: 'Panel',
      place: { x: 0, y: 0, w: 6, h: 4 },
      html: '<input>',
      css: '',
      javascript: '',
    };
    const setup = await openInterface(sessions, { blocks: () => [code] });
    const frame = screen
      .getAllByTitle('Panel')
      .find((node) => node.tagName === 'IFRAME')! as HTMLIFrameElement;
    const frameWindow = frame.contentWindow;
    const next = {
      ...code,
      ...(property === 'title' ? { title: 'Renamed panel' } : { place: { ...code.place, x: 6 } }),
    };
    await act(async () => {
      await setup.session.run([
        {
          kind: 'interface.update',
          interfaceId: setup.value.id,
          pages: [{ ...setup.value.pages[0]!, blocks: [next] }],
        },
      ]).done;
    });
    expect(screen.getAllByTitle(next.title).find((node) => node.tagName === 'IFRAME')).toBe(frame);
    expect(frame.contentWindow).toBe(frameWindow);
  });

  it('shows validation errors in place and saves one undoable command from a deep link', async () => {
    const setup = await openInterface(
      sessions,
      {},
      (value) => `/${value.fixture.databaseId}/interfaces/${value.value.id}/${PAGE_ID}?editor=json`,
    );
    const input = await screen.findByRole('textbox', { name: 'Page JSON' });
    fireEvent.change(input, { target: { value: '{' } });
    expect(screen.getByRole('alert').textContent).toContain('Check the JSON');
    expect(screen.getByRole('button', { name: 'Save page' }).hasAttribute('disabled')).toBe(true);
    const next = {
      ...setup.value.pages[0]!,
      name: 'New name',
      blocks: [
        {
          id: 'custom01',
          kind: 'code',
          title: 'Preview',
          place: { x: 0, y: 0, w: 6, h: 4 },
          html: '<p></p>',
          css: '',
          javascript: '',
        },
      ],
    };
    fireEvent.change(input, { target: { value: JSON.stringify(next) } });
    await userEvent.click(screen.getByRole('button', { name: 'Save page' }));
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    expect(setup.updates()[0]?.pages?.[0]).toEqual(next);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      screen
        .getAllByTitle('Preview')
        .find((node) => node.tagName === 'IFRAME')!
        .getAttribute('sandbox'),
    ).toBe('allow-scripts');
    expect(setup.router.state.location.searchStr).toBe('');
    await act(async () => {
      await setup.session.undo();
    });
    await waitFor(() =>
      expect(setup.session.getSchema().interfaceById.get(setup.value.id)?.pages[0]).toEqual(
        setup.value.pages[0],
      ),
    );
    expect(screen.queryAllByTitle('Preview').find((node) => node.tagName === 'IFRAME') ?? null).toBeNull();
  });

  it('keeps a draft open when the page changes elsewhere and prevents overwriting it', async () => {
    const setup = await openInterface(
      sessions,
      {},
      (value) => `/${value.fixture.databaseId}/interfaces/${value.value.id}/${PAGE_ID}?editor=json`,
    );
    const input = await screen.findByRole('textbox', { name: 'Page JSON' });
    const draft = JSON.stringify({ ...setup.value.pages[0]!, name: 'Draft' });
    fireEvent.change(input, { target: { value: draft } });
    await act(async () => {
      await setup.session.run([
        {
          kind: 'interface.update',
          interfaceId: setup.value.id,
          pages: [{ ...setup.value.pages[0]!, name: 'Shared change' }],
        },
      ]).done;
    });
    expect(screen.getByRole('alert').textContent).toContain('This page changed');
    expect((input as HTMLTextAreaElement).value).toBe(draft);
    expect(screen.getByRole('button', { name: 'Save page' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(setup.updates()).toHaveLength(1);
  });

  it('opens a readable record from a deep link and closes back to its selection', async () => {
    const setup = await openInterface(
      sessions,
      { blocks: (ids) => everyBlock(ids).filter((block) => block.kind === 'records') },
      (value) =>
        `/${value.fixture.databaseId}/interfaces/${value.value.id}/${PAGE_ID}?block=blkRecords01&record=${value.fixture.recordId(0)}&detail=record`,
    );
    await screen.findByRole('dialog', { name: 'Record details' });
    await userEvent.click(screen.getByRole('button', { name: 'Close record' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(setup.router.state.location.searchStr).toContain(`record=${setup.fixture.recordId(0)}`);
    expect(setup.router.state.location.searchStr).not.toContain('detail');
  });

  it('keeps editing unavailable to a reader with an editor deep link', async () => {
    await openInterface(
      sessions,
      { role: 'reader' },
      (value) => `/${value.fixture.databaseId}/interfaces/${value.value.id}/${PAGE_ID}?editor=json`,
    );
    expect(screen.queryByRole('textbox', { name: 'Page JSON' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit interface' })).toBeNull();
  });

  it('edits custom code with a live sandbox preview and cancels without saving', async () => {
    const setup = await openInterface(sessions);
    await userEvent.click(screen.getByRole('button', { name: 'Add a block' }));
    const kind = await screen.findByRole('button', { name: /Type/ });
    await userEvent.click(kind);
    await userEvent.click(screen.getByRole('option', { name: /^Custom code(?: |$)/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'HTML' }), { target: { value: '<main></main>' } });
    expect(screen.getByTitle('Live preview').getAttribute('src')).toBe('/api/interfaces/code-frame');
    const html = screen.getByRole('textbox', { name: 'HTML' });
    await userEvent.click(html);
    await userEvent.keyboard('{Escape}{Tab}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).not.toBe(html);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(setup.updates()).toEqual([]);
  });

  it('validates contract bounds, identity, duplicate IDs, and block references', () => {
    const block = { id: 'custom01', kind: 'code', place: { x: 0, y: 0, w: 6, h: 4 } };
    const page = { id: PAGE_ID, name: 'Page', blocks: [block] };
    const parse = (value: unknown) => parsePageJson(JSON.stringify(value), PAGE_ID, []);
    expect(parse(page).page?.blocks[0]).toMatchObject({ html: '', css: '', javascript: '' });
    expect(parse({ ...page, id: 'changed01' }).path).toBe('id');
    expect(parse({ ...page, blocks: [block, block] }).path).toBe('blocks.1.id');
    expect(parse({ ...page, blocks: [{ ...block, javascript: 'x'.repeat(50_001) }] }).path).toBe(
      'blocks.0.javascript',
    );
    expect(parse({ ...page, blocks: [{ ...block, kind: 'record', recordsBlockId: 'missing01' }] }).path).toBe(
      'blocks.0.recordsBlockId',
    );
  });
});
