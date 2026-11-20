import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocsPanel } from './DocsPanel';
import { listModules } from './loader';
import { requestHelp } from './help-request';

/** Help modules in the docs folder, so adding an article never means editing this test. */
const MODULES = readdirSync(join(import.meta.dirname, '../../../../docs/modules'), { withFileTypes: true })
  .filter((area) => area.isDirectory())
  .flatMap((area) => readdirSync(join(area.parentPath, area.name))).length;

const pdf = vi.hoisted(() => ({
  exportModulePdf: vi.fn(async () => {}),
  exportAllPdf: vi.fn(async () => {}),
}));
vi.mock('./pdf', () => pdf);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function panel(initial: string | null = null, hasUnits = true) {
  const onClose = vi.fn();
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  function Host() {
    const [moduleId, setModuleId] = useState(initial);
    return <DocsPanel moduleId={moduleId} hasUnits={hasUnits} onOpen={setModuleId} onClose={onClose} />;
  }
  render(
    <I18nProvider i18n={i18n}>
      <Host />
    </I18nProvider>,
  );
  return { onClose, i18n };
}

describe('DocsPanel', () => {
  it('keeps unit help out of the index before the first unit exists', async () => {
    panel(null, false);
    await screen.findByRole('searchbox', { name: 'Search help' });
    expect(screen.queryByRole('link', { name: 'Organizational units' })).toBeNull();
  });

  it('uses current translations with English fallbacks after changing language', async () => {
    const { i18n } = panel();
    await screen.findByRole('searchbox', { name: 'Search help' });
    act(() => {
      i18n.load('fr', { 'docs.search': 'Rechercher', 'docs.area.account': 'Compte' });
      i18n.activate('fr');
    });
    expect(await screen.findByRole('searchbox', { name: 'Rechercher' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Compte' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Close help' })).toBeDefined();
    expect(screen.getAllByRole('link')).toHaveLength(MODULES);
  });

  it('lists every module under its translated area and closes', async () => {
    const { onClose } = panel();
    await screen.findByRole('searchbox', { name: 'Search help' });
    for (const module of await listModules('en-US'))
      expect(screen.getByRole('link', { name: module.title })).toBeDefined();
    for (const name of ['Getting started', 'Appearance', 'Account', 'Administration'])
      expect(screen.getByRole('heading', { name })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Close help' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('filters titles and summaries, and shows an empty result', async () => {
    panel();
    const search = await screen.findByRole('searchbox', { name: 'Search help' });
    await userEvent.type(search, 'Choosing a theme');
    expect(screen.getByRole('link', { name: 'Choosing a theme' })).toBeDefined();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    await userEvent.clear(search);
    await userEvent.type(search, 'Meet Rio');
    expect(screen.getByRole('link', { name: 'Meet Rio' })).toBeDefined();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    await userEvent.clear(search);
    await userEvent.type(search, 'no matching topic');
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toBe('No help topics match your search.');
  });

  it('opens by keyboard, renders related links, and returns to the index', async () => {
    panel();
    await screen.findByRole('link', { name: 'Welcome to Riosoma' });
    screen.getByRole('link', { name: 'Welcome to Riosoma' }).focus();
    await userEvent.keyboard('{Enter}');
    const heading = await screen.findByRole('heading', { name: 'Welcome to Riosoma' });
    expect(document.activeElement).toBe(heading.parentElement);
    expect(screen.getByRole('heading', { name: 'Finding your way around', level: 3 })).toBeDefined();
    await userEvent.click(screen.getByRole('link', { name: 'Choosing a theme' }));
    await screen.findByRole('heading', { name: 'Choosing a theme', level: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'All topics' }));
    await screen.findByRole('searchbox', { name: 'Search help' });
    expect(screen.getByRole('searchbox', { name: 'Search help' })).toBeDefined();
    await userEvent.click(screen.getByRole('link', { name: 'Choosing a theme' }));
    expect(screen.getByRole('heading', { name: 'Choosing a theme', level: 2 })).toBeDefined();
  });

  it('downloads the selected module and all help from the index', async () => {
    panel('welcome');
    await userEvent.click(await screen.findByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(pdf.exportModulePdf).toHaveBeenCalledWith('welcome', 'en-US'));
    await userEvent.click(screen.getByRole('button', { name: 'All topics' }));
    await screen.findByRole('searchbox', { name: 'Search help' });
    await userEvent.click(screen.getByRole('button', { name: 'Download all help as PDF' }));
    await waitFor(() => expect(pdf.exportAllPdf).toHaveBeenCalledWith('en-US'));
  });

  it('handles an unknown module and can return to the index', async () => {
    panel('missing');
    expect((await screen.findByRole('alert')).textContent).toContain('This help topic could not be found.');
    await userEvent.click(screen.getByRole('button', { name: 'All topics' }));
    await screen.findByRole('searchbox', { name: 'Search help' });
    expect(screen.getAllByRole('link')).toHaveLength(MODULES);
  });

  it('reports an export failure and allows another attempt', async () => {
    pdf.exportModulePdf.mockRejectedValueOnce(new Error('Unavailable'));
    panel('welcome');
    await userEvent.click(await screen.findByRole('button', { name: 'Download PDF' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The PDF could not be downloaded.');
    await userEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(pdf.exportModulePdf).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('searches article text and revisits modules in both directions', async () => {
    panel('views');
    await userEvent.click(await screen.findByRole('button', { name: 'Search help' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search help' }), 'pins close together');
    await userEvent.click(screen.getByRole('link', { name: 'Working with a list or a map' }));
    await screen.findByRole('heading', { name: 'Working with a list or a map', level: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Views, filters, and sorting', level: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'Forward' }));
    await screen.findByRole('heading', { name: 'Working with a list or a map', level: 2 });
  });

  it('focuses a requested section and exposes the other matching modules', async () => {
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    const onOpen = vi.fn();
    render(
      <I18nProvider i18n={i18n}>
        <DocsPanel
          moduleId="views"
          section="filter"
          also={[{ id: 'fields', section: 'adding-and-editing-fields' }]}
          onOpen={onOpen}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
    const filter = await screen.findByRole('heading', { name: 'Filter', level: 3 });
    await waitFor(() => expect(document.activeElement).toBe(filter));
    const heading = screen.getByRole('heading', { name: 'Also about this screen' });
    const topic = within(heading.parentElement!).getByRole('link');
    await userEvent.click(topic);
    expect(onOpen).toHaveBeenCalledWith('fields', 'adding-and-editing-fields');
  });

  it('leaves search when returning to a section in the same module', async () => {
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    function Host() {
      const [topic, setTopic] = useState({ id: 'views', section: 'filter' });
      return (
        <DocsPanel
          moduleId={topic.id}
          section={topic.section}
          onOpen={(id, section) => setTopic({ id, section: section ?? '' })}
          onClose={vi.fn()}
        />
      );
    }
    render(
      <I18nProvider i18n={i18n}>
        <Host />
      </I18nProvider>,
    );
    await screen.findByRole('heading', { name: 'Filter', level: 3 });
    await userEvent.click(screen.getByRole('link', { name: 'Sort' }));
    await userEvent.click(screen.getByRole('button', { name: 'Search help' }));
    await screen.findByRole('searchbox');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Filter', level: 3 })),
    );
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('leaves search and focuses an externally requested section in the selected module', async () => {
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    const ui = (section: string) => (
      <I18nProvider i18n={i18n}>
        <DocsPanel moduleId="views" section={section} onOpen={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>
    );
    const { rerender } = render(ui('filter'));
    await screen.findByRole('heading', { name: 'Filter', level: 3 });
    await userEvent.click(screen.getByRole('button', { name: 'Search help' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search help' }), 'map');
    rerender(ui('sort'));
    await waitFor(() => expect(screen.queryByRole('searchbox')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Sort', level: 3 }));
  });

  it('leaves search when the external request repeats the current section', async () => {
    render(
      <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
        <DocsPanel moduleId="views" section="filter" onOpen={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    );
    await screen.findByRole('heading', { name: 'Filter', level: 3 });
    await userEvent.click(screen.getByRole('button', { name: 'Search help' }));
    await screen.findByRole('searchbox', { name: 'Search help' });
    act(() => requestHelp({ id: 'views', section: 'filter' }));
    await waitFor(() => expect(screen.queryByRole('searchbox')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Filter', level: 3 }));
    screen.getByRole('button', { name: 'Close help' }).focus();
    act(() => requestHelp({ id: 'views', section: 'filter' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Filter', level: 3 }));
  });
});
