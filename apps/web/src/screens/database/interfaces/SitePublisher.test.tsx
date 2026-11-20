import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteSettings, type PublishedSite } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data/types';
import { themes } from '../../../preferences';
import { json, session } from '../share/testing';
import { PAGE_ID } from './test-support';
import { openInterface } from './testing';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('publishing an interface', () => {
  it('lets a sharing owner publish selected pages and unpublish while keeping the address', async () => {
    vi.spyOn(themes, 'list').mockResolvedValue([
      {
        id: 'palette',
        name: 'Palette',
        css: '',
        manifest: '',
        defaultScheme: 'house',
        schemeCount: 1,
        modes: [],
      },
    ]);
    vi.spyOn(themes, 'manifest').mockResolvedValue({
      id: 'palette',
      name: 'Palette',
      css: '',
      defaultScheme: 'house',
      schemes: [{ id: 'house', name: 'House', appearance: 'light' }],
      modes: [],
      defaultMode: null,
      surfaces: [],
    });
    let published: PublishedSite | null = null;
    const saved = (): PublishedSite | null => published;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === '/api/admin/custom-domains') return json([]);
        if (url.endsWith('/site/preview')) {
          const input = JSON.parse(String(options?.body)) as { settings: SiteSettings };
          expect(input.settings.headerButton).toEqual({
            label: 'Visit our studio',
            action: { kind: 'page', pageId: PAGE_ID },
          });
          expect(input.settings.pages[0]?.navLabel).toBe('Home');
          expect(input.settings.pages[0]?.showInNav).toBe(false);
          expect(input.settings.footerFormat).toBe('markdown');
          expect(input.settings.motion).toBe('none');
          return json({
            html: `<!doctype html><html><body><header>${input.settings.headerButton?.label}</header><footer>${input.settings.footer}</footer></body></html>`,
          });
        }
        if (url.endsWith('/site')) {
          if (options?.method === 'PUT') {
            const settings = SiteSettings.parse(JSON.parse(String(options.body)));
            published = { settings, published: true, path: `/sites/${settings.slug}`, publisherId: null };
          }
          if (options?.method === 'DELETE') {
            published = { ...published!, published: false };
            return new Response(null, { status: 204 });
          }
          return json(published);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const setup = await openInterface(sessions, {
      pages: () => [{ id: 'secondPage', name: 'Private page', blocks: [] }],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Publish site' }));
    const dialog = await screen.findByRole('dialog');
    const page = await within(dialog).findByRole('group', { name: 'Private page' });
    await userEvent.click(within(page).getByRole('button', { name: 'Exclude page' }));
    expect(
      within(dialog)
        .getByRole('radio', { name: /^Subtle$/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
    await userEvent.click(within(dialog).getByRole('radio', { name: /^None$/ }));
    const title = within(dialog).getByRole('textbox', { name: 'Site title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Public directory');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Footer text' }), 'A public footer.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add header button' }));
    const header = within(dialog).getByRole('group', { name: 'Header button' });
    await userEvent.type(within(header).getByRole('textbox', { name: 'Label' }), 'Visit our studio');
    await userEvent.click(within(header).getByRole('radio', { name: 'Open a page' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Navigation label' }), 'Home');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Show in navigation' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Update preview' }));
    const frame = await within(dialog).findByTitle('Site preview');
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toContain('A public footer.');
    expect(frame.getAttribute('srcdoc')).toContain('Visit our studio');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish selected pages' }));
    await within(dialog).findByRole('link', { name: 'Visit site' });
    expect(saved()?.settings.pages.map((item) => item.pageId)).toEqual([setup.value.pages[0]!.id]);
    expect(saved()?.settings.title).toBe('Public directory');
    expect(saved()?.settings.motion).toBe('none');
    expect(saved()?.settings.footer).toBe('A public footer.');
    expect(saved()?.settings.footerFormat).toBe('markdown');
    expect(saved()?.settings.headerButton).toEqual({
      label: 'Visit our studio',
      action: { kind: 'page', pageId: setup.value.pages[0]!.id },
    });
    expect(saved()?.settings.pages[0]?.navLabel).toBe('Home');
    expect(saved()?.settings.pages[0]?.showInNav).toBe(false);
    expect((within(dialog).getByRole('textbox', { name: 'Site address' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unpublish site' }));
    await waitFor(() => expect(within(dialog).queryByRole('link', { name: 'Visit site' })).toBeNull());
    expect(saved()?.published).toBe(false);
    expect(saved()?.path).toBe(`/sites/${setup.value.id.toLowerCase()}`);
  });
  it('keeps a site’s custom domain for anyone who doesn’t manage the organization’s domains', async () => {
    vi.spyOn(themes, 'list').mockResolvedValue([]);
    vi.spyOn(themes, 'manifest').mockResolvedValue({
      id: 'palette',
      name: 'Palette',
      css: '',
      defaultScheme: 'house',
      schemes: [{ id: 'house', name: 'House', appearance: 'light' }],
      modes: [],
      defaultMode: null,
      surfaces: [],
    });
    const domainId = '6f1c1b2a-8f0e-4a4b-9c55-2d8f1f7a9e10';
    let sent: SiteSettings | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (!url.endsWith('/site')) throw new Error(`Unexpected request: ${url}`);
        const stored = SiteSettings.parse({
          slug: 'front-desk',
          title: 'Front desk',
          pages: [{ pageId: PAGE_ID, slug: 'home', title: 'Home' }],
          domainId,
        });
        if (options?.method === 'PUT') sent = SiteSettings.parse(JSON.parse(String(options.body)));
        return json({
          settings: sent ?? stored,
          published: true,
          path: '/sites/front-desk',
          publisherId: null,
        });
      }),
    );
    const member = { ...session, membership: { kind: 'member' as const, adminRoles: [] } };
    await openInterface(sessions, {}, undefined, member);
    await userEvent.click(screen.getByRole('button', { name: 'Publish site' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/^This site keeps its custom domain\./)).toBeDefined();
    expect(within(dialog).queryByRole('combobox', { name: 'Custom domain' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish selected pages' }));
    await waitFor(() => expect(sent?.domainId).toBe(domainId));
  });
  it('hides publishing from people without sharing permission', async () => {
    await openInterface(sessions, { role: 'creator' });
    expect(screen.queryByRole('button', { name: 'Publish site' })).toBeNull();
  });
  it('keeps a legacy footer plain through unrelated saves and enables Markdown after an edit', async () => {
    vi.spyOn(themes, 'list').mockResolvedValue([]);
    const footer = 'Support *our* work.  [Terms](https://example.com/terms)';
    const stored = SiteSettings.parse({
      slug: 'front-desk',
      title: 'Front desk',
      footer,
      pages: [{ pageId: PAGE_ID, slug: 'home', title: 'Home' }],
    });
    Reflect.deleteProperty(stored, 'footerFormat');
    let sent: SiteSettings | null = null;
    const saved = () => sent;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === '/api/admin/custom-domains') return json([]);
        if (url.endsWith('/site')) {
          if (options?.method === 'PUT') sent = SiteSettings.parse(JSON.parse(String(options.body)));
          return json({
            settings: sent ?? stored,
            published: true,
            path: '/sites/front-desk',
            publisherId: null,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    await openInterface(sessions);
    await userEvent.click(screen.getByRole('button', { name: 'Publish site' }));
    const dialog = await screen.findByRole('dialog');
    const title = await within(dialog).findByRole('textbox', { name: 'Site title' });
    await userEvent.type(title, ' directory');
    const save = within(dialog).getByRole('button', { name: 'Publish selected pages' });
    await userEvent.click(save);
    await waitFor(() => expect(saved()?.title).toBe('Front desk directory'));
    expect(saved()?.footer).toBe(footer);
    expect(saved()?.footerFormat).toBe('plain');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Footer text' }), '.');
    await userEvent.click(save);
    await waitFor(() => expect(saved()?.footer).toBe(`${footer}.`));
    expect(saved()?.footerFormat).toBe('markdown');
  });
});

it('reorders published navigation by keyboard before publishing', async () => {
  vi.spyOn(themes, 'list').mockResolvedValue([]);
  let sent: SiteSettings | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/admin/custom-domains') return json([]);
      if (url.endsWith('/site')) {
        if (options?.method === 'PUT') {
          sent = SiteSettings.parse(JSON.parse(String(options.body)));
          return json({ settings: sent, published: true, path: `/sites/${sent.slug}`, publisherId: null });
        }
        return json(null);
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const setup = await openInterface(sessions, {
    pages: () => [{ id: 'secondPage', name: 'Second page', blocks: [] }],
  });
  await userEvent.click(screen.getByRole('button', { name: 'Publish site' }));
  const handle = await screen.findByRole('button', { name: 'Move Second page' });
  handle.focus();
  await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
  expect(sent).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Publish selected pages' }));
  await waitFor(() =>
    expect(sent?.pages.map((page) => page.pageId)).toEqual(['secondPage', setup.value.pages[0]!.id]),
  );
});
