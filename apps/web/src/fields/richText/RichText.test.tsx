import { i18n as appI18n, setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Editor } from '@tiptap/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldMeta, type CellValue, type RowData, type ViewMeta } from '@riosoma/contracts';
import { gridColumns } from '../../grid/cells/columns';
import { createCellRenderer } from '../../grid/cells/renderers';
import { copyText } from '../../grid/clipboard/copy';
import { mountEditor } from '../../grid/editors/mountEditor';
import type { EditorProps } from '../../grid/editors/types';
import { editText, formatCell } from '../../grid/format';
import { renderField } from '../../screens/database/fields/fieldTestUtils';
import { RecordCard } from '../../screens/database/record/RecordCard';
import { AnswerEditor } from '../../screens/database/views/form/AnswerEditor';
import { richTextExtensions } from './extensions';
import { docToMarkdown } from './markdown';
import { RichTextInput, type RichTextInputProps } from './RichTextInput';
import { RichTextView } from './RichTextView';

const disposals: Array<() => void> = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => act(dispose));
  cleanup();
});

const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() };

function notes(richText = true, id = 'fld00000000000001'): FieldMeta {
  return FieldMeta.parse({
    id,
    tableId: 'tbl00000000000001',
    name: 'Notes',
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    type: 'longText',
    options: { richText },
  });
}

function record(values: RowData['values']): RowData {
  return {
    id: 'rec00000000000001',
    values,
    createdAt: '2026-09-27T15:05:00.000Z',
    updatedAt: '2026-09-27T15:05:00.000Z',
    createdBy: null,
    updatedBy: null,
  };
}

function input(value: string | null, props: Partial<RichTextInputProps> = {}) {
  const onChange = vi.fn();
  const outside = vi.fn();
  renderField(
    <div onKeyDown={outside}>
      <span id="notes-label">Notes</span>
      <RichTextInput value={value} labelId="notes-label" onChange={onChange} {...props} />
      <button type="button">Elsewhere</button>
    </div>,
  );
  return { onChange, outside, box: screen.getByRole('textbox', { name: 'Notes' }) };
}

async function selectAll(box: HTMLElement) {
  box.focus();
  await userEvent.keyboard('{Control>}a{/Control}');
}

const save = () => userEvent.keyboard('{Control>}{Enter}{/Control}');

describe('the rich text editor', () => {
  it('names every format, with its shortcut, in one toolbar over a labeled text box', () => {
    const { box } = input('hello');
    expect(box.getAttribute('aria-multiline')).toBe('true');
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    const tools = within(toolbar)
      .getAllByRole('button')
      .map((button) => [button.getAttribute('aria-label'), button.getAttribute('aria-keyshortcuts')]);
    expect(tools).toEqual([
      ['Bold', 'Control+B'],
      ['Italic', 'Control+I'],
      ['Strikethrough', 'Control+Shift+S'],
      ['Inline code', 'Control+E'],
      ['Link', null],
      ['Heading 1 (H1)', 'Control+Alt+1'],
      ['Heading 2 (H2)', 'Control+Alt+2'],
      ['Heading 3 (H3)', 'Control+Alt+3'],
      ['Bulleted list', 'Control+Shift+8'],
      ['Numbered list', 'Control+Shift+7'],
      ['Checklist', 'Control+Shift+9'],
      ['Block quote', 'Control+Shift+B'],
      ['Code block', 'Control+Alt+C'],
    ]);
  });

  it.each([
    ['Bold', '**hello**'],
    ['Italic', '_hello_'],
    ['Strikethrough', '~~hello~~'],
    ['Inline code', '`hello`'],
    ['Heading 1 (H1)', '# hello'],
    ['Heading 2 (H2)', '## hello'],
    ['Heading 3 (H3)', '### hello'],
    ['Bulleted list', '- hello'],
    ['Numbered list', '1. hello'],
    ['Checklist', '- [ ] hello'],
    ['Block quote', '> hello'],
    ['Code block', '```\nhello\n```'],
  ])('applies %s from the toolbar and stores %j', async (tool, markdown) => {
    const { box, onChange } = input('hello');
    // Formats of words apply to the selection, and formats of lines to the line with the caret.
    if (markdown.includes('hello*') || /[~`]hello/.test(markdown) || markdown.startsWith('_'))
      await selectAll(box);
    else box.focus();
    const button = screen.getByRole('button', { name: tool });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    // The tool hands the focus back to the text.
    expect(document.activeElement).toBe(box);
    await save();
    expect(onChange).toHaveBeenLastCalledWith(markdown);
  });

  it.each([
    ['{Control>}b{/Control}', '**hello**'],
    ['{Control>}i{/Control}', '_hello_'],
    ['{Control>}{Shift>}s{/Shift}{/Control}', '~~hello~~'],
    ['{Control>}e{/Control}', '`hello`'],
    ['{Control>}{Alt>}2{/Alt}{/Control}', '## hello'],
    ['{Control>}{Shift>}8{/Shift}{/Control}', '- hello'],
    ['{Control>}{Shift>}7{/Shift}{/Control}', '1. hello'],
    ['{Control>}{Shift>}9{/Shift}{/Control}', '- [ ] hello'],
    ['{Control>}{Shift>}b{/Shift}{/Control}', '> hello'],
    ['{Control>}{Alt>}c{/Alt}{/Control}', '```\nhello\n```'],
  ])('applies %s from the keyboard and stores %j', async (keys, markdown) => {
    const { box, onChange } = input('hello');
    await selectAll(box);
    await userEvent.keyboard(keys);
    await save();
    expect(onChange).toHaveBeenLastCalledWith(markdown);
  });

  it('turns off formatting that code blocks can’t hold', async () => {
    const { box } = input('```\ncode\n```');
    box.focus();
    expect(screen.getByRole('button', { name: 'Bold' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Code block' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('saves when the focus leaves, and only when something changed', async () => {
    // Written another way, but opening and leaving it never rewrites it.
    const { box, onChange } = input('* one\n* two', { autoFocus: true });
    await waitFor(() => expect(document.activeElement).toBe(box));
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onChange).not.toHaveBeenCalled();
    // Moving to the toolbar stays inside the editor, so nothing saves yet.
    box.focus();
    await userEvent.keyboard('!');
    await userEvent.click(screen.getByRole('button', { name: 'Italic' }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onChange).toHaveBeenLastCalledWith('- one\n- two!');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('saves emptied text as nothing', async () => {
    const { box, onChange } = input('hello');
    await selectAll(box);
    await userEvent.keyboard('{Backspace}');
    await save();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('puts back the saved text on Escape, and lets Escape through when nothing changed', async () => {
    const { box, onChange, outside } = input('hello', { autoFocus: true });
    await waitFor(() => expect(document.activeElement).toBe(box));
    await userEvent.keyboard(' world');
    expect(box.textContent).toBe('hello world');
    await userEvent.keyboard('{Escape}');
    expect(box.textContent).toBe('hello');
    expect(outside).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
    await userEvent.keyboard('{Escape}');
    expect(outside).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('takes a new value from elsewhere, and keeps its own saved value as it is', async () => {
    const onChange = vi.fn();
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    const at = (value: string) => (
      <I18nProvider i18n={i18n}>
        <RichTextInput value={value} label="Notes" autoFocus onChange={onChange} />
      </I18nProvider>
    );
    const { rerender } = render(at('first'));
    const box = screen.getByRole('textbox', { name: 'Notes' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    await userEvent.keyboard(' try');
    await save();
    expect(onChange).toHaveBeenLastCalledWith('first try');
    rerender(at('first try'));
    expect(box.textContent).toBe('first try');
    rerender(at('**second**'));
    await waitFor(() => expect(box.querySelector('strong')?.textContent).toBe('second'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('links only to web and mail addresses', async () => {
    const { box, onChange } = input('hello');
    await selectAll(box);
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    const address = screen.getByRole('textbox', { name: 'Link address' });
    expect(document.activeElement).toBe(address);
    await userEvent.type(address, 'javascript:alert(1){Enter}');
    expect(
      screen.getByText('Enter a web address, such as https://example.com, or an email address.'),
    ).toBeDefined();
    expect(box.querySelector('a')).toBeNull();
    await userEvent.clear(address);
    await userEvent.type(address, 'example.com{Enter}');
    expect(screen.queryByRole('textbox', { name: 'Link address' })).toBeNull();
    await save();
    expect(onChange).toHaveBeenLastCalledWith('[hello](https://example.com)');

    // Opening it again shows the address, a way to open it, and a way to take it off.
    await selectAll(box);
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect((screen.getByRole('textbox', { name: 'Link address' }) as HTMLInputElement).value).toBe(
      'https://example.com',
    );
    const open = screen.getByRole('link', { name: /Open link/ });
    expect(open.getAttribute('href')).toBe('https://example.com');
    expect(open.getAttribute('target')).toBe('_blank');
    await userEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    await save();
    expect(onChange).toHaveBeenLastCalledWith('hello');
  });

  it('adds an email address as a mailto link, with the address as its text', async () => {
    const { box, onChange } = input(null);
    box.focus();
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Link address' }), 'ada@example.com{Enter}');
    await save();
    expect(onChange).toHaveBeenLastCalledWith('<ada@example.com>');
  });

  it('adds the link on Ctrl+Enter in the link bar, and saves on Ctrl+Enter in the text', async () => {
    const { box, onChange } = input('hello');
    await selectAll(box);
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Link address' }), 'https://example.com');
    await save();
    expect(screen.queryByRole('textbox', { name: 'Link address' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    await save();
    // Saving never adds the line break Ctrl+Enter makes elsewhere.
    expect(onChange).toHaveBeenLastCalledWith('[hello](https://example.com)');
  });

  it('closes the link bar on Escape without leaving the editor', async () => {
    const { box, outside } = input('hello');
    await selectAll(box);
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Link address' })).toBeNull();
    expect(document.activeElement).toBe(box);
    expect(outside).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
  });

  it('checks a checklist item with its checkbox', async () => {
    const { onChange } = input('- [ ] Buy milk\n- [x] Call Ada');
    const milk = screen.getByRole('checkbox', { name: 'Buy milk' }) as HTMLInputElement;
    expect(milk.checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Call Ada' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(milk);
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onChange).toHaveBeenLastCalledWith('- [x] Buy milk\n- [x] Call Ada');
  });

  it('turns Markdown typed at the start of a line into its format', async () => {
    const { box, onChange } = input(null);
    await userEvent.type(box, '## Plan');
    await save();
    expect(onChange).toHaveBeenLastCalledWith('## Plan');
  });
});

describe('rendering rich text', () => {
  const dangerous = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<iframe src="https://example.com"></iframe>',
    '[click](javascript:alert(1))',
    '[also](JaVaScRiPt:alert(1))',
    '<javascript:alert(1)>',
    '[data](data:text/html,<b>x</b>)',
    '&lt;b&gt;not bold&lt;/b&gt; &amp; &#x3C;',
    '<a href="javascript:alert(1)">raw</a>',
  ].join('\n\n');

  it('never turns a value into markup: scripts, images, and bad links stay text', () => {
    const { container } = renderField(<RichTextView value={dangerous} />);
    expect(container.querySelector('script, img, iframe, object, embed, style, a')).toBeNull();
    expect(container.querySelector('[onerror], [onclick]')).toBeNull();
    const text = container.textContent ?? '';
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<img src=x onerror="alert(1)">');
    expect(text).toContain('[click](javascript:alert(1))');
    expect(text).toContain('<javascript:alert(1)>');
    expect(text).toContain('&lt;b&gt;not bold&lt;/b&gt; &amp; &#x3C;');
    expect(text).toContain('<a href="javascript:alert(1)">raw</a>');
  });

  it('shows the formats, with links that open in a new tab and checkboxes that can’t change', () => {
    const { container } = renderField(
      <RichTextView
        value={
          '## Plan\n\n**Bold** _it_ ~~gone~~ `code` [site](https://example.com)\n\n- [x] Done\n\n> Quote\n\n```\nls\n```'
        }
      />,
    );
    const view = container.querySelector('.rio-rich-text__content')!;
    expect(view.getAttribute('contenteditable')).toBe('false');
    expect(view.getAttribute('role')).toBe('presentation');
    expect(view.querySelector('h2')?.textContent).toBe('Plan');
    expect(view.querySelector('strong')?.textContent).toBe('Bold');
    expect(view.querySelector('em')?.textContent).toBe('it');
    expect(view.querySelector('s')?.textContent).toBe('gone');
    expect(view.querySelector('code')?.textContent).toBe('code');
    const link = view.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    const done = screen.getByRole('checkbox', { name: 'Done' }) as HTMLInputElement;
    expect(done.checked).toBe(true);
    expect(done.disabled).toBe(true);
    expect(view.querySelector('blockquote')?.textContent).toBe('Quote');
    expect(view.querySelector('pre')?.textContent).toBe('ls');
  });

  it('reduces pasted HTML to the formats it keeps', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const editor = new Editor({
      element,
      injectCSS: false,
      extensions: richTextExtensions({ checkboxLabel: (text) => text }),
    });
    disposals.push(() => {
      editor.destroy();
      element.remove();
    });
    editor.view.pasteHTML(
      [
        '<h1 style="color: red">Title</h1>',
        '<p><span style="font-size: 40px">Big</span> <u>under</u> <b>bold</b> <i>it</i> <s>gone</s> <code>x</code> ',
        '<a href="javascript:alert(1)">bad</a> <a href="https://example.com" onclick="alert(1)">good</a>',
        '<img src="x" onerror="alert(1)"><script>alert(1)</script></p>',
        '<table><tr><td>cell</td></tr></table><hr>',
        '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked> done</li></ul>',
        '<blockquote>quote</blockquote><pre><code>code</code></pre>',
      ].join(''),
    );
    expect(docToMarkdown(editor.getJSON())).toBe(
      [
        '# Title',
        'Big under **bold** _it_ ~~gone~~ `x` bad [good](https://example.com)',
        'cell',
        '- [x] done',
        '> quote',
        '```\ncode\n```',
      ].join('\n\n'),
    );
  });
});

describe('rich text in the grid and the record card', () => {
  const view = { config: {} } as unknown as ViewMeta;

  it('edits rich text and plain long text in editors that retain their starting values', () => {
    const [rich, plain] = gridColumns(
      { ...view, config: { hiddenFieldIds: [], fieldOrder: [], columnWidths: {} } } as unknown as ViewMeta,
      [notes(true), notes(false, 'fld00000000000002')],
      'fld00000000000009',
    );
    expect(rich?.edit).toBe('custom');
    expect(plain?.edit).toBe('custom');
  });

  it('shows the words on one line, and copies and edits the Markdown', () => {
    const value = '# Plan\n\n- **Call** Ada\n- [x] Ship it\n\n> Soon';
    expect(formatCell(notes(), value, format)).toBe('Plan Call Ada Ship it Soon');
    expect(copyText(notes(), value, format)).toBe(value);
    expect(editText(notes(), value, format)).toBe(value);
    // Plain long text reads, copies, and edits exactly as before.
    expect(formatCell(notes(false), value, format)).toBe(value);
    expect(copyText(notes(false), value, format)).toBe(value);

    const field = notes();
    const draw = createCellRenderer({ fieldsById: new Map([[field.id, field]]), format, rowHeight: 'short' });
    const el = document.createElement('div');
    draw(el, {
      row: record({ [field.id]: value }),
      rowIndex: 0,
      column: { id: field.id, width: 200, edit: 'custom' },
      colIndex: 0,
      selected: false,
      active: false,
    });
    expect(el.textContent).toBe('Plan Call Ada Ship it Soon');
    expect(el.querySelector('strong, h1, li')).toBeNull();
  });

  function mount(value: CellValue, initialText: string | null = null) {
    // Grid editors render with the app's own catalog.
    appI18n.load('en-US', {});
    appI18n.activate('en-US');
    const field = notes();
    const anchor = document.createElement('div');
    document.body.append(anchor);
    const apply = vi.fn();
    const request: EditorProps['request'] = {
      anchor,
      initialText,
      row: record({ [field.id]: value }),
      cell: { row: 0, col: 0 },
      column: { id: field.id, width: 180, edit: 'custom' },
      done: vi.fn(),
      cancel: vi.fn(),
    };
    act(() => {
      const dispose = mountEditor(request, {
        field,
        format,
        canEditOptions: false,
        apply,
        addOption: () => '',
      });
      disposals.push(() => {
        dispose();
        anchor.remove();
      });
    });
    return { request, apply };
  }

  it('opens a cell formatted, and saves with Save and moves down', async () => {
    const { request, apply } = mount('**Bold** start');
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    expect(box.querySelector('strong')?.textContent).toBe('Bold');
    await waitFor(() => expect(document.activeElement).toBe(box));
    await userEvent.keyboard(' more');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(apply).toHaveBeenCalledWith('**Bold** start more');
    expect(request.done).toHaveBeenCalledWith('down');
  });

  it('saves with Ctrl+Enter, and closes without writing when nothing changed', async () => {
    const { request, apply } = mount('same');
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    box.focus();
    await save();
    expect(apply).not.toHaveBeenCalled();
    expect(request.done).toHaveBeenCalledWith('down');
  });

  it('leaves the cell as it was on Escape, and saves on a click elsewhere', async () => {
    const first = mount('before');
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    await userEvent.keyboard(' after');
    await userEvent.keyboard('{Escape}');
    expect(first.apply).not.toHaveBeenCalled();
    expect(first.request.cancel).toHaveBeenCalled();
    disposals.splice(0).forEach((dispose) => act(dispose));

    const second = mount('before');
    const again = await screen.findByRole('textbox', { name: 'Notes' });
    await waitFor(() => expect(document.activeElement).toBe(again));
    await userEvent.keyboard(' after');
    fireEvent.pointerDown(document.body);
    expect(second.apply).toHaveBeenCalledWith('before after');
    expect(second.request.cancel).toHaveBeenCalled();
  });

  it('starts over with what was typed on the cell', async () => {
    const { apply } = mount('old text', 'N');
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    expect(box.textContent).toBe('N');
    await waitFor(() => expect(document.activeElement).toBe(box));
    await userEvent.keyboard('ew');
    await save();
    expect(apply).toHaveBeenCalledWith('New');
  });

  function card(readOnly: boolean, value: string) {
    const field = notes();
    const onChange = vi.fn();
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    render(
      <I18nProvider i18n={i18n}>
        <RecordCard
          fields={[field]}
          primaryFieldId=""
          row={record({ [field.id]: value })}
          format={format}
          readOnly={readOnly}
          canEditOptions={false}
          position={null}
          onChange={onChange}
          onAddOption={() => ''}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
    return onChange;
  }

  it('edits rich text in the record card, and saves it as the field’s value', async () => {
    const onChange = card(false, 'Plain start');
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    await selectAll(box);
    await userEvent.click(screen.getByRole('button', { name: 'Bold' }));
    await save();
    expect(onChange).toHaveBeenLastCalledWith('fld00000000000001', '**Plain start**');
  });

  it('asks a form’s rich text question with the same editor, and answers with its Markdown', async () => {
    const onChange = vi.fn();
    renderField(
      <>
        <span id="question">Notes</span>
        <AnswerEditor field={notes()} value={null} format={format} labelId="question" onChange={onChange} />
      </>,
    );
    const box = screen.getByRole('textbox', { name: 'Notes' });
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeDefined();
    await userEvent.type(box, '- milk');
    await save();
    expect(onChange).toHaveBeenLastCalledWith('fld00000000000001', '- milk');
  });

  it('shows rich text formatted when the record can’t be changed', async () => {
    card(true, '## Heading\n\n<b>not html</b>');
    const group = screen.getByRole('group', { name: 'Notes' });
    await waitFor(() => expect(group.querySelector('h2')?.textContent).toBe('Heading'));
    expect(group.querySelector('b')).toBeNull();
    expect(group.textContent).toContain('<b>not html</b>');
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
});
