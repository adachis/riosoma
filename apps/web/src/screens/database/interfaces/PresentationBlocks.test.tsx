import { i18n } from '@lingui/core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Block, idsOf, InterfacePage } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data/types';
import { attachment } from '../../../files/testing';
import { renderSharing } from '../share/testing';
import { closeAll, interfaceFixture, PAGE_ID } from './test-support';
import { openInterface, pageBlocks, pick } from './testing';
import { parsePageJson } from './page-json';
import { MarkdownText } from './MarkdownText';
import { HeroBody, MediaBody } from './PresentationBlocks';
import { TextBody } from './SmallBlocks';
import type { BlockContext } from './context';

const sessions: DatabaseSession[] = [];
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
});

async function add(kind: string, fill: () => Promise<void>) {
  await userEvent.click(screen.getAllByRole('button', { name: 'Add a block' })[0]!);
  const dialog = await screen.findByRole('dialog', { name: 'Add a block' });
  await pick('Type', kind);
  await fill();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save block' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

async function mediaFixture() {
  const setup = await interfaceFixture();
  sessions.push(setup.session);
  const { session, fixture, ids } = setup;
  await session.run([{ kind: 'field.convert', fieldId: ids.number, to: { type: 'attachment', options: {} } }])
    .done;
  const image = { ...attachment('Studio.png', 'image/png'), scanState: 'clean' as const };
  const poster = { ...attachment('Poster.png', 'image/png'), scanState: 'clean' as const };
  const video = { ...attachment('Tour.mp4', 'video/mp4'), scanState: 'clean' as const };
  session.rememberAttachments(Object.fromEntries([image, poster, video].map((file) => [file.id, file])));
  const reference = {
    tableId: ids.tableId,
    fieldId: ids.number,
    recordId: fixture.recordId(0),
    attachmentId: image.id,
  };
  const update = async (attachmentIds: string[]) => {
    await act(async () => {
      await session.run([
        {
          kind: 'record.update',
          tableId: ids.tableId,
          records: [{ id: reference.recordId, values: { [reference.fieldId]: attachmentIds } }],
        },
      ]).done;
    });
  };
  const schema = session.getSchema();
  const context: BlockContext = {
    session,
    schema,
    interfaceId: setup.value.id,
    page: setup.value.pages[0]!,
    canEditRecords: false,
    format: { locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators },
    filters: {},
    selected: {},
    onFilter: () => undefined,
    onSelect: () => undefined,
    onMissing: () => undefined,
    summaries: new Map(),
    onRetry: () => undefined,
  };
  return { ...setup, image, poster, video, reference, context, update };
}

describe('presentation in the interface designer', () => {
  it.each(['sections', 'cards', 'list'] as const)(
    'saves and restores enlargement beside the %s cover setting',
    async (display) => {
      const setup = await openInterface(sessions, {
        blocks: (ids) => [
          Block.parse({
            id: 'records01',
            kind: 'records',
            title: 'Projects',
            display,
            enlarge: true,
            source: { tableId: ids.tableId, viewId: ids.viewId },
            place: { x: 0, y: 0, w: 12, h: 4 },
          }),
        ],
      });
      await userEvent.click(screen.getByRole('button', { name: 'Edit interface' }));
      await userEvent.click(screen.getByRole('button', { name: 'More for Projects' }));
      await userEvent.click(screen.getByRole('menuitem', { name: /^Edit(?: |$)/ }));
      const editor = await screen.findByRole('dialog', { name: 'Edit block' });
      const enlarge = within(editor).getByRole('checkbox', { name: 'Enlarge on press' });
      expect((enlarge as HTMLInputElement).checked).toBe(true);
      expect(
        within(editor).getByRole('button', {
          name: new RegExp(
            display === 'sections'
              ? 'Section media field'
              : display === 'cards'
                ? 'Card cover field'
                : 'List cover field',
          ),
        }),
      ).toBeDefined();
      await userEvent.click(enlarge);
      await userEvent.click(within(editor).getByRole('button', { name: 'Save block' }));
      await waitFor(() => expect(pageBlocks(setup)[0]).toMatchObject({ enlarge: false }));
    },
  );

  it.each(['cards', 'list'] as const)(
    'keeps every record selectable in a %s preview when the first field becomes empty',
    async (display) => {
      const setup = await openInterface(sessions, {
        count: 2,
        blocks: (ids) => [
          Block.parse({
            id: 'records01',
            kind: 'records',
            title: 'Projects',
            source: { tableId: ids.tableId, viewId: ids.viewId },
            fieldIds: [ids.status, ids.number],
            display,
            showFieldNames: false,
            place: { x: 0, y: 0, w: 12, h: 4 },
          }),
          Block.parse({
            id: 'details01',
            kind: 'record',
            title: 'Details',
            recordsBlockId: 'records01',
            fieldIds: [ids.name],
            place: { x: 0, y: 4, w: 12, h: 4 },
          }),
        ],
      });
      const projects = within(screen.getByRole('article', { name: 'Projects' }));
      expect(await projects.findByRole('button', { name: 'Open' })).toBeDefined();
      await act(async () => {
        await setup.session.run([
          {
            kind: 'record.update',
            tableId: setup.ids.tableId,
            records: [
              { id: setup.fixture.recordId(0), values: { [setup.ids.status]: null } },
              { id: setup.fixture.recordId(1), values: { [setup.ids.number]: null } },
            ],
          },
        ]).done;
      });
      await waitFor(() => expect(projects.queryByRole('button', { name: 'Open' })).toBeNull());
      expect(projects.getAllByRole('button')).toHaveLength(2);
      expect(projects.getAllByRole('heading', { level: 3, name: /Untitled record|Done/ })).toHaveLength(2);
      const fallback = projects.getByRole('button', { name: 'Untitled record' });
      expect(fallback.closest('article')?.querySelector('p')?.textContent).toBe('0');
      expect(
        projects.getByRole('button', { name: 'Done' }).closest('article')?.querySelector('p'),
      ).toBeNull();
      await userEvent.click(fallback);
      await waitFor(() =>
        expect(setup.router.state.location.search).toMatchObject({ record: setup.fixture.recordId(0) }),
      );
      const details = within(screen.getByRole('article', { name: 'Details' }));
      await waitFor(() =>
        expect((details.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Record 1'),
      );
      expect(fallback.getAttribute('aria-pressed')).toBe('true');
    },
  );

  it.each(['cards', 'list'] as const)(
    'keeps every record selectable by keyboard in a %s preview with no selected fields',
    async (display) => {
      const setup = await openInterface(sessions, {
        count: 2,
        blocks: (ids) => [
          Block.parse({
            id: 'records01',
            kind: 'records',
            title: 'Projects',
            source: { tableId: ids.tableId, viewId: ids.viewId },
            fieldIds: [],
            display,
            showFieldNames: false,
            place: { x: 0, y: 0, w: 12, h: 4 },
          }),
        ],
      });
      const container = screen.getByRole('article', { name: 'Projects' });
      const projects = within(container);
      await projects.findByText('2 records');
      const buttons = projects.getAllByRole('button', { name: 'Untitled record' });
      expect(buttons).toHaveLength(2);
      expect(projects.getAllByRole('heading', { level: 3, name: 'Untitled record' })).toHaveLength(2);
      expect(container.querySelectorAll('.rio-interface-record-title ~ p')).toHaveLength(0);
      buttons[0]!.focus();
      await userEvent.keyboard('{Enter}');
      await waitFor(() =>
        expect(setup.router.state.location.search).toMatchObject({ record: setup.fixture.recordId(0) }),
      );
      await userEvent.tab();
      expect(document.activeElement).toBe(buttons[1]);
      await userEvent.keyboard(' ');
      await waitFor(() =>
        expect(setup.router.state.location.search).toMatchObject({ record: setup.fixture.recordId(1) }),
      );
      expect(buttons[0]!.getAttribute('aria-pressed')).toBe('false');
      expect(buttons[1]!.getAttribute('aria-pressed')).toBe('true');
    },
  );

  it.each(['cards', 'list'] as const)(
    'shows selected values with record headings and no field names in a %s preview',
    async (display) => {
      const setup = await openInterface(sessions, {
        count: 2,
        blocks: (ids) => [
          Block.parse({
            id: 'records01',
            kind: 'records',
            source: { tableId: ids.tableId, viewId: ids.viewId },
            fieldIds: [ids.status, ids.number],
            display,
            showFieldNames: false,
            place: { x: 0, y: 0, w: 12, h: 4 },
          }),
        ],
      });
      expect(await screen.findByRole('heading', { level: 3, name: 'Open' })).toBeDefined();
      expect(screen.getByRole('heading', { level: 3, name: 'Done' })).toBeDefined();
      expect(screen.queryByText(/^Status:|^Number:/)).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() =>
        expect(setup.router.state.location.search).toMatchObject({ record: setup.fixture.recordId(1) }),
      );
    },
  );

  it('preserves saved paragraph headings, inline code, and safe email links', () => {
    const block = Block.parse({
      id: 'text001',
      kind: 'text',
      text: '# Studio updates\n\nUse `project_id` and [Email us](mailto:studio@example.test).\n\n[Unsafe](javascript:alert(1))',
      place: { x: 0, y: 0, w: 12, h: 4 },
    });
    if (block.kind !== 'text') throw new Error('Expected a text block');
    const view = render(<TextBody block={block} />);
    expect(screen.getByRole('heading', { name: 'Studio updates', level: 4 })).toBeDefined();
    expect(view.container.querySelector('code')?.textContent).toBe('project_id');
    expect(screen.getByRole('link', { name: 'Email us' }).getAttribute('href')).toBe(
      'mailto:studio@example.test',
    );
    expect(screen.queryByRole('link', { name: 'Unsafe' })).toBeNull();
  });

  it.each(['hero', 'media'] as const)('removes a %s image when its source record changes', async (kind) => {
    const setup = await mediaFixture();
    await setup.update([setup.image.id]);
    const block = Block.parse({
      id: 'image001',
      kind,
      image: setup.reference,
      attachment: setup.reference,
      alt: 'Studio',
      place: { x: 0, y: 0, w: 12, h: 4 },
    });
    renderSharing(
      block.kind === 'hero' ? (
        <HeroBody block={block} context={setup.context} />
      ) : block.kind === 'media' ? (
        <MediaBody block={block} context={setup.context} />
      ) : null,
    );
    expect((await screen.findByRole('img', { name: 'Studio' })).getAttribute('src')).toBe(setup.image.url);
    await setup.update([]);
    expect(
      idsOf(
        setup.session.cachedRecord(setup.reference.tableId, setup.reference.recordId)?.values[
          setup.reference.fieldId
        ] ?? null,
      ),
    ).toEqual([]);
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Studio' })).toBeNull());
    await setup.update([setup.image.id]);
    expect(await screen.findByRole('img', { name: 'Studio' })).toBeDefined();
  });

  it('updates and removes a video poster as its source record changes', async () => {
    const setup = await mediaFixture();
    await setup.update([setup.video.id, setup.image.id]);
    const block = Block.parse({
      id: 'video001',
      kind: 'media',
      mediaType: 'video',
      attachment: { ...setup.reference, attachmentId: setup.video.id },
      alt: 'Tour',
      place: { x: 0, y: 0, w: 12, h: 4 },
    });
    if (block.kind !== 'media') throw new Error('Expected a media block');
    const view = renderSharing(<MediaBody block={block} context={setup.context} />);
    await waitFor(() =>
      expect(view.container.querySelector('video')?.getAttribute('poster')).toBe(setup.image.url),
    );
    await setup.update([setup.video.id, setup.poster.id]);
    await waitFor(() =>
      expect(view.container.querySelector('video')?.getAttribute('poster')).toBe(setup.poster.url),
    );
    await setup.update([setup.video.id]);
    await waitFor(() => expect(view.container.querySelector('video')?.hasAttribute('poster')).toBe(false));
    await act(async () => {
      await setup.session.run([
        {
          kind: 'record.trash',
          tableId: setup.reference.tableId,
          recordIds: [setup.reference.recordId],
        },
      ]).done;
    });
    await waitFor(() => expect(view.container.querySelector('video')).toBeNull());
    await act(async () => {
      await setup.session.run([
        {
          kind: 'record.restore',
          tableId: setup.reference.tableId,
          recordIds: [setup.reference.recordId],
        },
      ]).done;
    });
    await waitFor(() =>
      expect(view.container.querySelector('video')?.getAttribute('src')).toBe(setup.video.url),
    );
  });

  it('formats heading text without nesting paragraphs or lists inside the heading', () => {
    const view = render(<MarkdownText text={'Opening **studio**\n\n- First\n- Second'} heading />);
    const heading = screen.getByRole('heading', { name: 'Opening studio' });
    expect(heading.querySelector('strong')?.textContent).toBe('studio');
    expect(heading.querySelector('p, ul, ol')).toBeNull();
    expect(view.container.querySelectorAll('ul > li')).toHaveLength(2);
  });
  it('edits a hero, two destination buttons, a lead, media captions, and a card grid', async () => {
    const setup = await openInterface(sessions, {
      pages: () => [{ id: 'aboutPage', name: 'About', blocks: [] }],
    });
    await add('Hero', async () => {
      await userEvent.type(screen.getByRole('textbox', { name: 'Heading' }), 'Our studio');
      await userEvent.type(screen.getByRole('textbox', { name: 'Lead paragraph' }), 'A **careful** opening.');
      await userEvent.click(screen.getByRole('button', { name: 'Add button' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Label' }), 'Read more');
      await userEvent.click(screen.getByRole('radio', { name: 'Open a page' }));
      await pick('Destination page', 'About');
      await userEvent.click(screen.getByRole('button', { name: 'Add button' }));
      const second = screen.getByRole('group', { name: 'Button 2' });
      await userEvent.type(within(second).getByRole('textbox', { name: 'Label' }), 'Partner');
      await userEvent.type(
        within(second).getByRole('textbox', { name: 'Web address' }),
        'https://example.test/',
      );
      expect(screen.queryByRole('button', { name: 'Add button' })).toBeNull();
    });
    expect(screen.getByRole('heading', { name: 'Our studio' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Read more' }).getAttribute('href')).toContain('/aboutPage');
    await add('Text', async () => {
      await userEvent.click(screen.getByRole('radio', { name: 'Lead paragraph' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Text' }), 'A larger paragraph.');
    });
    await add('Image or video', async () => {
      await userEvent.click(screen.getByRole('radio', { name: 'Video' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Alternative text' }), 'Our studio tour');
      await userEvent.type(screen.getByRole('textbox', { name: 'Caption' }), 'A look inside.');
    });
    await add('Records', async () => {
      await userEvent.click(screen.getByRole('radio', { name: 'Cards' }));
      const names = screen.getByRole('checkbox', { name: 'Show field names' });
      expect((names as HTMLInputElement).checked).toBe(true);
      await userEvent.click(names);
      await userEvent.click(screen.getByRole('button', { name: 'Add a field' }));
      await userEvent.click(screen.getByRole('menuitem', { name: /^Name$/ }));
    });
    expect(pageBlocks(setup).map((block) => block.kind)).toEqual(['hero', 'text', 'media', 'records']);
    expect(pageBlocks(setup)[0]).toMatchObject({
      heading: 'Our studio',
      buttons: [
        { label: 'Read more', action: { kind: 'page', pageId: 'aboutPage' } },
        { label: 'Partner', action: { kind: 'url', url: 'https://example.test/' } },
      ],
    });
    expect(pageBlocks(setup)[1]).toMatchObject({ style: 'lead' });
    expect(pageBlocks(setup)[2]).toMatchObject({
      mediaType: 'video',
      alt: 'Our studio tour',
      caption: 'A look inside.',
    });
    expect(pageBlocks(setup)[3]).toMatchObject({
      display: 'cards',
      fieldIds: [setup.ids.name],
      showFieldNames: false,
    });
  });

  it('preserves all presentation settings through the page JSON editor', () => {
    const reference = {
      tableId: 'tbl00000000000000',
      fieldId: 'fld00000000000000',
      recordId: 'rec00000000000000',
      attachmentId: 'att00000000000000',
    };
    const place = { x: 0, y: 0, w: 12, h: 4 };
    const page = InterfacePage.parse({
      id: PAGE_ID,
      name: 'Home',
      blocks: [
        {
          id: 'hero001',
          kind: 'hero',
          heading: 'Studio',
          text: '**Welcome**',
          image: reference,
          alt: 'Studio',
          buttons: [{ label: 'About', action: { kind: 'page', pageId: 'aboutPage' } }],
          place,
        },
        {
          id: 'media001',
          kind: 'media',
          mediaType: 'video',
          attachment: reference,
          alt: 'Tour',
          caption: 'Inside',
          place,
        },
        { id: 'lead001', kind: 'text', style: 'lead', text: 'Opening', place },
        {
          id: 'cards001',
          kind: 'records',
          source: { tableId: reference.tableId, viewId: 'viw00000000000000' },
          coverFieldId: reference.fieldId,
          display: 'cards',
          place,
        },
      ],
    });
    expect(parsePageJson(JSON.stringify(page), page.id, [page])).toEqual({ page });
  });
});
