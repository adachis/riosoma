import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocView } from './DocView';

afterEach(cleanup);

function view(body: string) {
  const i18n = setupI18n({
    locale: 'en-US',
    messages: { 'en-US': { 'control.save': 'Save changes' }, fr: { 'control.save': 'Enregistrer' } },
  });
  const onOpen = vi.fn();
  const rendered = render(
    <I18nProvider i18n={i18n}>
      <DocView body={body} onOpen={onOpen} titles={new Map([['themes', 'Choosing a theme']])} />
    </I18nProvider>,
  );
  return { ...rendered, i18n, onOpen };
}

describe('DocView', () => {
  it('renders tables with column headers', () => {
    const { container } = view(
      '| Field | Holds |\n| --- | --- |\n| Rating | Stars from **1** to 10 |\n| Duration | Hours and minutes |',
    );
    const table = screen.getByRole('table');
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Field', 'Holds']);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(table.querySelector('td strong')?.textContent).toBe('1');
    expect(container.textContent).not.toContain('|');
  });

  it('renders supported Markdown elements with shifted heading levels', () => {
    const { container } = view(
      '# First\n\n## Second\n\n##### Deep\n\nA paragraph with *emphasis*, **strong**, and `inline code`.\n\n```ts\nconst value = 1;\n```\n\n- One\n- Two\n\n3. Third\n4. Fourth\n\n> A quotation\n\n---',
    );
    expect(screen.getByRole('heading', { level: 2, name: 'First' })).toBeDefined();
    expect(screen.getByRole('heading', { level: 3, name: 'Second' })).toBeDefined();
    expect(screen.getByRole('heading', { level: 6, name: 'Deep' })).toBeDefined();
    expect(container.querySelector('p')?.textContent).toContain('A paragraph');
    expect(container.querySelector('em')?.textContent).toBe('emphasis');
    expect(container.querySelector('strong')?.textContent).toBe('strong');
    expect(container.querySelector('p code')?.textContent).toBe('inline code');
    expect(container.querySelector('pre code')?.textContent).toBe('const value = 1;');
    expect(screen.getAllByRole('list')).toHaveLength(2);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(container.querySelector('ol')?.start).toBe(3);
    expect(container.querySelector('blockquote')?.textContent).toBe('A quotation');
    expect(screen.getByRole('separator')).toBeDefined();
  });

  it('translates control names reactively, hides shortcuts, and opens document macros by keyboard', async () => {
    const { container, i18n, onOpen } = view(
      'Choose {{ui:control.save}} {{keys:save}} and read {{doc:themes}}.',
    );
    expect(container.querySelector('.rio-doc-control')?.textContent).toBe('Save changes');
    expect(container.textContent).not.toContain('{{');
    act(() => i18n.activate('fr'));
    expect(container.querySelector('.rio-doc-control')?.textContent).toBe('Enregistrer');
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Choosing a theme' }));
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith('themes');
  });

  it('supports document destinations and secure external links, and flattens unsafe links', async () => {
    const { onOpen } = view(
      '[A topic]({{doc:themes}}) and [A website](https://example.com/help) and [Unsafe](javascript:alert%281%29) and [Relative](/settings) and [Email](mailto:hello@example.com)',
    );
    await userEvent.click(screen.getByRole('link', { name: 'A topic' }));
    expect(onOpen).toHaveBeenCalledWith('themes');
    const external = screen.getByRole('link', { name: /A website/ });
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByText(/Unsafe/).textContent).toContain('Relative');
  });

  it('drops raw HTML blocks and treats code as literal text', () => {
    const { container } = view(
      '<div>Hidden HTML</div>\n\n<script>alert(1)</script>\n\n`<img src=x onerror=alert(1)>`\n\n```\n{{ui:control.save}}\n```',
    );
    expect(container.textContent).not.toContain('Hidden HTML');
    expect(container.querySelector('script, img')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(container.querySelector('pre')?.textContent).toBe('{{ui:control.save}}');
  });
});
