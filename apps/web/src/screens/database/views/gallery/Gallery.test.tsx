import { StrictMode, type ReactElement } from 'react';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldMeta, newId, type AttachmentMeta } from '@riosoma/contracts';
import { openDatabase } from '../../../../data/session';
import { useSchema } from '../../../../data/hooks';
import { FakeServer, type FakeFixture } from '../../../../data/testing';
import { settle } from '../../../../data/testing/relational';
import type { DatabaseSession } from '../../../../data/types';
import type { ViewComponentProps } from '../types';
import { GallerySettings, GalleryView } from './index';

let width = 860;
let height = 400;
const observers = new Set<() => void>();
const sessions: DatabaseSession[] = [];
beforeEach(() => {
  width = 860;
  height = 400;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('rio-gallery-view__viewport') ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('rio-gallery-view__viewport') ? height : 0;
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private measure: (() => void) | undefined;
      constructor(private callback: ResizeObserverCallback) {}
      observe(node: Element) {
        if (!node.classList.contains('rio-gallery-view__viewport')) return;
        this.measure = () => this.callback([], this as unknown as ResizeObserver);
        observers.add(this.measure);
      }
      unobserve() {}
      disconnect() {
        if (this.measure) observers.delete(this.measure);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.close();
  observers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(count = 30, configure?: (server: FakeServer, fixture: FakeFixture) => void) {
  const server = new FakeServer();
  const fixture = server.createDatabase(count);
  server.database(fixture.databaseId).view(fixture.viewId).type = 'gallery';
  configure?.(server, fixture);
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  const schema = session.getSchema();
  const props: ViewComponentProps = {
    session,
    table: schema.tableById.get(fixture.tableId)!,
    view: schema.viewById.get(fixture.viewId)!,
    fields: schema.fields.get(fixture.tableId)!,
    format: { locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators },
    canEdit: true,
    onConfig: vi.fn(),
    onExpand: vi.fn(),
  };
  return { server, fixture, session, props };
}

function mount(element: ReactElement) {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  return render(element, { wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider> });
}

function attachmentField(fixture: FakeFixture, name = 'Photos') {
  return FieldMeta.parse({
    id: newId('field'),
    tableId: fixture.tableId,
    name,
    type: 'attachment',
    options: {},
    position: 2,
    description: '',
    createdAt: '',
    updatedAt: '',
  });
}

function image(id: string): AttachmentMeta {
  return {
    id,
    name: 'Photo.png',
    type: 'image/png',
    size: 100,
    width: 1200,
    height: 800,
    createdAt: '',
    url: '/photo.png',
    thumbnails: { small: '/small.png', large: '/large.png' },
  };
}

describe('gallery', () => {
  it.each([
    ['small', 220, 1],
    ['small', 620, 3],
    ['small', 1010, 5],
    ['medium', 220, 1],
    ['medium', 860, 3],
    ['medium', 1200, 4],
    ['large', 220, 1],
    ['large', 800, 2],
    ['large', 1200, 3],
  ] as const)('fits %s cards in %i pixels into %i columns', async (size, available, columns) => {
    width = available;
    const { props } = await setup(30, (server, fixture) => {
      server.database(fixture.databaseId).view(fixture.viewId).config.gallery.cardSize = size;
    });
    mount(<GalleryView {...props} />);
    await screen.findByRole('gridcell', { name: /^Record 1(?: |$)/ });
    const first = screen
      .getByRole('gridcell', { name: /^Record 1(?: |$)/ })
      .closest<HTMLElement>('.rio-gallery-view__line')!;
    expect(first.children).toHaveLength(columns);
    expect(first.style.gridTemplateColumns).toBe(`repeat(${columns}, minmax(0, 1fr))`);
  });

  it('resizes columns and keeps only visible card rows mounted, paging placeholders as needed', async () => {
    const { props, server } = await setup(2000);
    mount(<GalleryView {...props} />);
    await screen.findByRole('gridcell', { name: /^Record 1(?: |$)/ });
    expect(screen.getAllByRole('gridcell')).toHaveLength(6);
    expect(screen.queryByRole('gridcell', { name: /^Record 7(?: |$)/ })).toBeNull();
    act(() => {
      width = 600;
      for (const measure of observers) measure();
    });
    expect(
      screen.getByRole('gridcell', { name: /^Record 1(?: |$)/ }).closest('.rio-gallery-view__line')!.children,
    ).toHaveLength(2);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.beforeRequest = (request) => (request.path.includes('/rows?') ? blocked : Promise.resolve());
    const list = screen.getByRole('grid');
    fireEvent.scroll(list, { target: { scrollTop: 16 + 150 * 292 } });
    expect(screen.queryByRole('gridcell', { name: /^Record 1(?: |$)/ })).toBeNull();
    expect(screen.getAllByRole('gridcell')).toHaveLength(4);
    expect(screen.getAllByRole('gridcell').every((card) => card.getAttribute('aria-busy') === 'true')).toBe(
      true,
    );
    await act(settle);
    expect(server.requests.some((request) => request.path.includes('offset=200'))).toBe(true);
    await act(async () => {
      release();
      await settle();
    });
    expect(screen.getByRole('gridcell', { name: /^Record 301(?: |$)/ })).toBeTruthy();
    expect(screen.getAllByRole('gridcell')).toHaveLength(4);
  });

  it('shows loading placeholders before the first page and an empty state only after it arrives', async () => {
    const { props, server } = await setup(0);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.beforeRequest = (request) => (request.path.includes('/rows?') ? blocked : Promise.resolve());
    mount(<GalleryView {...props} />);
    expect(screen.getByRole('grid').getAttribute('aria-busy')).toBe('true');
    expect(screen.getAllByRole('gridcell')).toHaveLength(3);
    expect(screen.queryByText('No records yet')).toBeNull();
    await act(async () => {
      release();
      await settle();
    });
    expect(screen.getByRole('status').textContent).toBe('No records yet');
    expect(screen.queryAllByRole('gridcell')).toHaveLength(0);
    expect(screen.getByRole('grid').tabIndex).toBe(0);
  });

  it('formats the title and visible fields in saved order, including computed values', async () => {
    const { props } = await setup(1, (server, fixture) => {
      const database = server.database(fixture.databaseId);
      const field = FieldMeta.parse({
        ...database.field(fixture.textFieldId),
        id: newId('field'),
        name: 'Record ID',
        type: 'recordId',
        position: 2,
      });
      database.schema.fields.push(field);
      database.view(fixture.viewId).config.fieldOrder = [field.id, fixture.numberFieldId];
      database.view(fixture.viewId).config.hiddenFieldIds = [fixture.textFieldId];
      const row = database.rows(fixture.tableId).get(fixture.recordId(0))!;
      database.rows(fixture.tableId).set({
        ...row,
        values: { ...row.values, [fixture.textFieldId]: '', [fixture.numberFieldId]: 1234.5 },
      });
    });
    const rendered = mount(<GalleryView {...props} />);
    await waitFor(() => expect(screen.getByRole('gridcell').getAttribute('aria-busy')).toBeNull());
    const card = screen.getByRole('gridcell', { name: /^Untitled record(?: |$)/ });
    expect([...card.querySelectorAll('dt')].map((node) => node.textContent)).toEqual(['Record ID', 'Number']);
    expect(within(card).getByText('1,234.5')).toBeTruthy();
    expect(card.querySelector('dd')!.textContent).toMatch(/^rec/);
    rendered.rerender(
      <GalleryView
        {...props}
        view={{ ...props.view, config: { ...props.view.config, hiddenFieldIds: [props.fields[1]!.id] } }}
      />,
    );
    expect(within(screen.getByRole('gridcell')).queryByText('Number')).toBeNull();
  });

  it.each(['small', 'medium', 'large'] as const)(
    'uses the first image and the correct %s thumbnail with a fixed placeholder',
    async (size) => {
      const photo = image(newId('attachment'));
      const document = { ...image(newId('attachment')), type: 'application/pdf' };
      const unknown = newId('attachment');
      const { props } = await setup(4, (server, fixture) => {
        const database = server.database(fixture.databaseId);
        const field = attachmentField(fixture);
        database.schema.fields.push(field);
        database.view(fixture.viewId).config.gallery = {
          coverFieldId: field.id,
          coverFit: 'fit',
          cardSize: size,
        };
        for (const [index, ids] of [
          [0, [document.id, photo.id]],
          [1, [unknown, photo.id]],
          [2, [document.id]],
        ] as const) {
          const row = database.rows(fixture.tableId).get(fixture.recordId(index))!;
          database.rows(fixture.tableId).set({ ...row, values: { ...row.values, [field.id]: [...ids] } });
        }
      });
      const attachment = (id: string) =>
        id === photo.id ? photo : id === document.id ? document : undefined;
      mount(<GalleryView {...props} attachment={attachment} />);
      const card = await screen.findByRole('gridcell', { name: /^Record 1(?: |$)/ });
      const img = card.querySelector('img')!;
      expect(img.getAttribute('src')).toBe(size === 'large' ? '/large.png' : '/small.png');
      expect(img.parentElement!.getAttribute('data-fit')).toBe('fit');
      expect(screen.getByRole('gridcell', { name: /^Record 2(?: |$)/ }).querySelector('img')).toBeNull();
      fireEvent.error(img);
      expect(card.querySelector('img')).toBeNull();
      expect(card.querySelector('.rio-gallery-view-card__cover')).toBeTruthy();
    },
  );

  it('roves one tab stop with arrows, scrolls to distant cards, and opens with Enter or click', async () => {
    const { props, fixture } = await setup(1000);
    mount(<GalleryView {...props} />);
    await screen.findByRole('gridcell', { name: /^Record 1(?: |$)/ });
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New record' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: /^Record 1(?: |$)/ }));
    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: /^Record 5(?: |$)/ }));
    expect(screen.getAllByRole('gridcell').filter((card) => card.tabIndex === 0)).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(props.onExpand).toHaveBeenLastCalledWith(fixture.recordId(4));
    await user.keyboard('{End}');
    await screen.findByRole('gridcell', { name: /^Record 1000(?: |$)/ });
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: /^Record 1000(?: |$)/ }));
    await user.keyboard('{ArrowRight}{Enter}');
    expect(props.onExpand).toHaveBeenLastCalledWith(fixture.recordId(999));
    await user.keyboard('{Home}{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: /^Record 1(?: |$)/ }));
    await user.click(screen.getByRole('gridcell', { name: /^Record 2(?: |$)/ }));
    expect(props.onExpand).toHaveBeenLastCalledWith(fixture.recordId(1));
    await user.tab();
    expect(screen.getByRole('grid').contains(document.activeElement)).toBe(false);
  });

  it('creates and opens an undoable record for record editors without settings access', async () => {
    const { props, session, server, fixture } = await setup(0, (server, fixture) => {
      server.database(fixture.databaseId).schema.database.role = 'editor';
    });
    mount(<GalleryView {...props} canEdit={false} />);
    await screen.findByText('No records yet');
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard('{Enter}');
    expect(props.onExpand).toHaveBeenCalledOnce();
    await waitFor(() => expect(session.saveState().pending).toBe(0));
    const created = server.changes(fixture.databaseId).find((change) => change.kind === 'record.created');
    expect(created?.kind === 'record.created' && created.records[0]?.id).toBe(
      vi.mocked(props.onExpand).mock.calls[0]?.[0],
    );
    expect(session.canUndo()).toBe(true);
    await act(async () => {
      await session.undo();
      await settle();
    });
    expect(screen.getByText('No records yet')).toBeTruthy();
  });

  it('disables creation for readers and settings without schema permission', async () => {
    const { props } = await setup(1, (server, fixture) => {
      server.database(fixture.databaseId).schema.database.role = 'reader';
    });
    mount(
      <>
        <GallerySettings {...props} canEdit={false} />
        <GalleryView {...props} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'New record' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Cards' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'New record' }));
    expect(props.onExpand).not.toHaveBeenCalled();
  });

  it('keeps remote additions and sort changes in a pill until keyboard refresh', async () => {
    const { props, server, fixture } = await setup(10, (server, fixture) => {
      server.database(fixture.databaseId).view(fixture.viewId).config.sorts = [
        { fieldId: fixture.numberFieldId, direction: 'asc' },
      ];
    });
    mount(<GalleryView {...props} />);
    await screen.findByRole('gridcell', { name: /^Record 1(?: |$)/ });
    const positions = () =>
      screen
        .getAllByRole('gridcell')
        .map((node) => node.querySelector('.rio-gallery-view-card__title')?.textContent);
    const before = positions();
    await act(async () => {
      server.remote(fixture.databaseId, [
        {
          kind: 'record.create',
          tableId: fixture.tableId,
          records: [
            {
              id: newId('record'),
              values: { [fixture.textFieldId]: 'Incoming', [fixture.numberFieldId]: -1 },
            },
          ],
        },
      ]);
      await settle();
    });
    const pill = await screen.findByRole('button', { name: '1 new record' });
    expect(positions()).toEqual(before);
    expect(screen.queryByRole('gridcell', { name: /^Incoming(?: |$)/ })).toBeNull();
    pill.focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('gridcell', { name: /^Incoming(?: |$)/ });
    await waitFor(() => expect(screen.queryByRole('button', { name: '1 new record' })).toBeNull());
    await act(async () => {
      server.remote(fixture.databaseId, [
        {
          kind: 'record.update',
          tableId: fixture.tableId,
          records: [{ id: fixture.recordId(0), values: { [fixture.numberFieldId]: 100 } }],
        },
      ]);
      await settle();
    });
    expect(screen.getByRole('button', { name: 'View changed' })).toBeTruthy();
    expect(screen.getByRole('gridcell', { name: /^Record 1(?: |$)/ }).getAttribute('aria-colindex')).toBe(
      '2',
    );
  });

  it('updates covers when metadata arrives through the same accessor and clears a removed cover', async () => {
    const photo = image(newId('attachment'));
    const details = new Map<string, AttachmentMeta>();
    const { props } = await setup(1, (server, fixture) => {
      const database = server.database(fixture.databaseId);
      const field = attachmentField(fixture);
      database.schema.fields.push(field);
      database.view(fixture.viewId).config.gallery.coverFieldId = field.id;
      const row = database.rows(fixture.tableId).get(fixture.recordId(0))!;
      database.rows(fixture.tableId).set({ ...row, values: { ...row.values, [field.id]: [photo.id] } });
    });
    const attachment = (id: string) => details.get(id);
    const rendered = mount(<GalleryView {...props} attachment={attachment} />);
    const card = await screen.findByRole('gridcell', { name: /^Record 1(?: |$)/ });
    expect(card.querySelector('img')).toBeNull();
    details.set(photo.id, photo);
    rendered.rerender(<GalleryView {...props} attachment={attachment} />);
    expect(card.querySelector('img')?.getAttribute('src')).toBe('/small.png');
    expect(card.querySelector('.rio-gallery-view-card__cover')?.getAttribute('data-fit')).toBe('crop');
    rendered.rerender(
      <GalleryView
        {...props}
        attachment={attachment}
        view={{
          ...props.view,
          config: { ...props.view.config, gallery: { ...props.view.config.gallery, coverFieldId: null } },
        }}
      />,
    );
    expect(card.querySelector('img')).toBeNull();
  });

  it('keeps keyboard focus in the visible rows after pointer scrolling', async () => {
    const { props } = await setup(1000);
    mount(<GalleryView {...props} />);
    const first = await screen.findByRole('gridcell', { name: /^Record 1(?: |$)/ });
    act(() => first.focus());
    fireEvent.scroll(screen.getByRole('grid'), { target: { scrollTop: 16 + 100 * 292 } });
    await screen.findByRole('gridcell', { name: /^Record 301(?: |$)/ });
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: /^Record 301(?: |$)/ }));
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: /^Record 302(?: |$)/ }));
  });

  it('preserves a partially visible anchor when remote records are accepted', async () => {
    const { props, server, fixture } = await setup(1000, (server, fixture) => {
      server.database(fixture.databaseId).view(fixture.viewId).config.sorts = [
        { fieldId: fixture.numberFieldId, direction: 'asc' },
      ];
    });
    mount(<GalleryView {...props} />);
    await screen.findByRole('gridcell', { name: /^Record 1(?: |$)/ });
    const list = screen.getByRole('grid');
    fireEvent.scroll(list, { target: { scrollTop: 16 + 100 * 292 + 30 } });
    await screen.findByRole('gridcell', { name: /^Record 301(?: |$)/ });
    await act(async () => {
      server.remote(fixture.databaseId, [
        {
          kind: 'record.create',
          tableId: fixture.tableId,
          records: Array.from({ length: 3 }, (_, index) => ({
            id: newId('record'),
            values: { [fixture.textFieldId]: `Incoming ${index}`, [fixture.numberFieldId]: -3 + index },
          })),
        },
      ]);
      await settle();
    });
    expect(list.scrollTop).toBe(16 + 100 * 292 + 30);
    await userEvent.click(screen.getByRole('button', { name: '3 new records' }));
    await waitFor(() => expect(list.scrollTop).toBe(16 + 101 * 292 + 30));
    expect(screen.getByRole('gridcell', { name: /^Record 301(?: |$)/ })).toBeTruthy();
  });

  it('closes the rows subscription when unmounted, including strict effect remounting', async () => {
    const { props, session } = await setup();
    const open = vi.spyOn(session, 'openView');
    const rendered = mount(
      <StrictMode>
        <GalleryView {...props} />
      </StrictMode>,
    );
    await screen.findByRole('gridcell', { name: /^Record 1(?: |$)/ });
    const rows = open.mock.results.at(-1)!.value;
    const close = vi.spyOn(rows, 'close');
    rendered.unmount();
    expect(close).toHaveBeenCalledOnce();
  });

  it('saves labeled card settings through undoable view commands and restores trigger focus', async () => {
    const { props, session, fixture } = await setup(1, (server, fixture) => {
      server.database(fixture.databaseId).schema.fields.push(attachmentField(fixture));
    });
    function Host() {
      const schema = useSchema(session)!;
      return (
        <GallerySettings
          {...props}
          view={schema.viewById.get(fixture.viewId)!}
          onConfig={(config) => {
            session.run([{ kind: 'view.update', viewId: fixture.viewId, config }]);
          }}
        />
      );
    }
    mount(<Host />);
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Cards' })).toBeTruthy();
    const cover = screen.getByRole('button', { name: /Cover image/ });
    cover.focus();
    await user.keyboard('{Enter}');
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['None', 'Photos']);
    screen.getByRole('listbox').focus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(session.getSchema().viewById.get(fixture.viewId)!.config.gallery.coverFieldId).toBe(
      props.fields[2]!.id,
    );
    await user.click(screen.getByRole('button', { name: /Fit/ }));
    screen.getByRole('listbox').focus();
    await user.keyboard('{ArrowDown}{Enter}');
    await user.click(screen.getByRole('button', { name: /Card size/ }));
    screen.getByRole('listbox').focus();
    await user.keyboard('{End}{Enter}');
    await waitFor(() => expect(session.saveState().pending).toBe(0));
    expect(session.getSchema().viewById.get(fixture.viewId)!.config.gallery).toEqual({
      coverFieldId: props.fields[2]!.id,
      coverFit: 'fit',
      cardSize: 'large',
    });
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cards' }));
    await act(async () => {
      await session.undo();
      await settle();
    });
    expect(session.getSchema().viewById.get(fixture.viewId)!.config.gallery.cardSize).toBe('medium');
  });
});

describe('gallery drop regressions', () => {
  it.each(['ltr', 'rtl'])(
    'places cards along the %s inline axis and marks the insertion edge',
    async (direction) => {
      const { props, fixture, session } = await setup(3);
      const run = vi.spyOn(session, 'run');
      mount(<GalleryView {...props} />);
      const card = await screen.findByRole('gridcell', { name: /^Record 1(?: |$)/ });
      const target = screen.getByRole('gridcell', { name: /^Record 2(?: |$)/ });
      target.style.direction = direction;
      vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        top: 0,
        width: 100,
        height: 100,
      } as DOMRect);
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
      fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 180, clientY: 20 });
      expect(target.dataset.rioDropSide).toBe(direction === 'rtl' ? 'before' : 'after');
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 180, clientY: 20 });
      expect(run).toHaveBeenCalledWith([
        expect.objectContaining({
          kind: 'record.move',
          place: direction === 'rtl' ? { before: fixture.recordId(1) } : { after: fixture.recordId(1) },
        }),
      ]);
      expect(target.dataset.rioDropSide).toBeUndefined();
    },
  );
  it('keeps selection anchored to the record after a peer reorder', async () => {
    const { props, fixture, server } = await setup(3);
    mount(<GalleryView {...props} />);
    const selected = await screen.findByRole('gridcell', { name: /^Record 2(?: |$)/ });
    fireEvent.focus(selected);
    server.remote(fixture.databaseId, [
      {
        kind: 'record.move',
        tableId: fixture.tableId,
        viewId: fixture.viewId,
        recordIds: [fixture.recordId(2)],
        place: { before: fixture.recordId(0) },
      },
    ]);
    await waitFor(() =>
      expect(
        screen.getAllByRole('gridcell')[0]?.querySelector('.rio-gallery-view-card__title')?.textContent,
      ).toBe('Record 3'),
    );
    expect(screen.getByRole('gridcell', { name: /^Record 2(?: |$)/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
  it('leaves public cards free of gestures', async () => {
    const { props } = await setup(3);
    mount(<GalleryView {...props} readOnly />);
    const card = await screen.findByRole('gridcell', { name: /^Record 1(?: |$)/ });
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(
      screen.getByRole('gridcell', { name: /^Record 2(?: |$)/ }),
    );
    fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 100 });
    expect(document.querySelector('[data-rio-drop]')).toBeNull();
    expect(document.querySelector('.rio-view-drag-status')).toBeNull();
    expect(card.getAttribute('aria-keyshortcuts')).toBeNull();
  });
});

it('includes the visible record fields in each gallery card name', async () => {
  const { props } = await setup(1);
  mount(<GalleryView {...props} />);
  const card = await screen.findByRole('gridcell', { name: /^Record 1 Number 0/ });
  expect(card.textContent).toContain('Number');
});
