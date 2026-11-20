import { dragItem } from '../../../test/sortable';
import { useState, type ReactElement } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColorConfig, FieldMeta, GridConfig } from '@riosoma/contracts';
import { ColorEditor } from './ColorEditor';
import { ViewToolbar } from './ViewToolbar';

const open = 'cho00000000000001';
const fields = [
  ['Name', 'text'],
  ['Amount', 'number'],
  ['Due', 'date'],
  ['Status', 'singleSelect'],
].map(([name, type], position) =>
  FieldMeta.parse({
    id: `fld${String(position).padStart(14, '0')}`,
    tableId: 'tbl00000000000000',
    name,
    type,
    position,
    description: '',
    createdAt: '',
    updatedAt: '',
    options: type === 'singleSelect' ? { choices: [{ id: open, name: 'Open', color: 'blue' }] } : {},
  }),
);
const [name, amount, due, status] = fields as [FieldMeta, FieldMeta, FieldMeta, FieldMeta];

afterEach(cleanup);

function mount(ui: ReactElement) {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  return render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
}

function editor(initial: unknown = {}) {
  const changed = vi.fn<(value: ColorConfig) => void>();
  function Host() {
    const [value, setValue] = useState(() => ColorConfig.parse(initial));
    return (
      <ColorEditor
        fields={fields}
        primaryFieldId={name.id}
        value={value}
        onChange={(patch) => {
          const next = { ...value, ...patch };
          setValue(next);
          changed(next);
        }}
      />
    );
  }
  mount(<Host />);
  return () => changed.mock.calls.at(-1)![0];
}

async function choose(trigger: HTMLElement, option: string) {
  await userEvent.click(trigger);
  await userEvent.click(
    screen.getByRole('option', {
      name: (accessibleName, element) =>
        accessibleName === option ||
        element?.querySelector('.rio-listbox-item__label')?.textContent === option,
    }),
  );
}

const rule = (id: string, color: string, value: number) => ({
  id,
  target: 'cell',
  condition: { id: `${id}c`, fieldId: amount.id, operator: 'gt', value },
  color,
});

describe('ColorEditor rules', () => {
  it('edits icon styles, thresholds, and text alternatives and removes the set', async () => {
    const latest = editor();
    await userEvent.click(screen.getByRole('button', { name: 'Add icon set' }));
    expect(latest().iconSets[0]).toMatchObject({ fieldId: amount.id, thresholds: [0, 100] });
    await choose(screen.getByRole('button', { name: /Icon style/ }), 'Ratings');
    const cutoff = screen.getByRole('textbox', { name: 'High threshold' });
    await userEvent.clear(cutoff);
    await userEvent.type(cutoff, '20');
    await userEvent.tab();
    await userEvent.type(screen.getByRole('textbox', { name: 'Band 3 text alternative' }), 'Excellent');
    expect(latest().iconSets[0]).toMatchObject({
      style: 'ratings',
      thresholds: [0, 20],
      labels: ['', '', 'Excellent'],
    });
    expect(screen.getByRole('button', { name: 'Add icon set' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Remove icon set' }));
    expect(latest().iconSets).toEqual([]);
  });
  it('adds a rule and edits its color, target, name, and condition', async () => {
    const latest = editor();
    expect(screen.getByText(/No rules yet/)).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(latest().colorRules).toEqual([
      {
        id: expect.any(String),
        name: '',
        target: 'cell',
        condition: { id: expect.any(String), fieldId: name.id, operator: 'contains' },
        color: 'red',
      },
    ]);
    const group = screen.getByRole('group', { name: 'Name contains' });
    await choose(within(group).getAllByRole('button', { name: /Field/ })[0]!, 'Status');
    await choose(within(group).getByRole('button', { name: /Condition/ }), 'is');
    await userEvent.type(within(group).getByRole('combobox', { name: 'Value' }), 'Open');
    await userEvent.click(screen.getByRole('option', { name: /^Open(?: |$)/ }));
    expect(latest().colorRules[0]!.condition).toMatchObject({
      fieldId: status.id,
      operator: 'is',
      value: open,
    });
    // Unnamed rules are called by their condition, which screen readers hear on the cells.
    const named = screen.getByRole('group', { name: 'Status is Open' });
    await choose(within(named).getByRole('button', { name: /^Red/ }), 'Green');
    await userEvent.click(within(named).getByRole('radio', { name: 'Record' }));
    expect(within(named).getByRole('textbox', { name: 'Name' }).getAttribute('placeholder')).toBe(
      'Status is Open',
    );
    await userEvent.type(within(named).getByRole('textbox', { name: 'Name' }), 'Ready');
    expect(latest().colorRules[0]).toMatchObject({ color: 'green', target: 'record', name: 'Ready' });
    expect(screen.getByRole('group', { name: 'Ready' })).toBeDefined();
  });

  it('adds each new rule in a color its neighbors don’t use', async () => {
    const latest = editor({ colorRules: [rule('a', 'red', 1)] });
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(latest().colorRules.map((each) => each.color)).toEqual(['red', 'green']);
  });

  it('reorders rules with the keyboard and by dragging, and removes them', async () => {
    const latest = editor({ colorRules: [rule('a', 'red', 1), rule('b', 'green', 2), rule('c', 'blue', 3)] });
    const handles = screen.getAllByRole('button', { name: 'Move rule' });
    act(() => handles[1]!.focus());
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(latest().colorRules.map((each) => each.id)).toEqual(['b', 'a', 'c']);
    expect(document.activeElement).toBe(handles[1]);
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(latest().colorRules.map((each) => each.id)).toEqual(['b', 'a', 'c']);
    const moved = screen.getAllByRole('button', { name: 'Move rule' })[0]!;
    const target = screen.getAllByRole('button', { name: 'Move rule' })[2]!;
    await dragItem(moved, target);
    expect(latest().colorRules.map((each) => each.id)).toEqual(['a', 'c', 'b']);
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove rule' })[1]!);
    expect(latest().colorRules.map((each) => each.id)).toEqual(['a', 'b']);
  });

  it('warns about a condition that doesn’t fit its field', () => {
    editor({
      colorRules: [
        {
          id: 'x',
          target: 'cell',
          condition: { id: 'c', fieldId: amount.id, operator: 'contains', value: 'a' },
          color: 'red',
        },
      ],
    });
    expect(
      screen
        .getByText('This condition doesn’t fit its field, so it colors nothing.')
        .getAttribute('aria-hidden'),
    ).toBe('false');
  });
});

describe('ColorEditor scales and bars', () => {
  it('adds a scale, adds a middle color, fixes a value, and moves it to a date field', async () => {
    const latest = editor();
    await userEvent.click(screen.getByRole('button', { name: 'Add color scale' }));
    expect(latest().colorScales).toEqual([
      {
        fieldId: amount.id,
        stops: [
          { color: 'red', value: null },
          { color: 'green', value: null },
        ],
      },
    ]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Middle color' }));
    expect(latest().colorScales[0]!.stops.map((stop) => stop.color)).toEqual(['red', 'yellow', 'green']);
    await userEvent.type(screen.getByRole('textbox', { name: 'Lowest value' }), '5');
    expect(latest().colorScales[0]!.stops[0]).toEqual({ color: 'red', value: 5 });
    await choose(screen.getByRole('button', { name: /^Amount/ }), 'Due');
    expect(latest().colorScales).toEqual([
      {
        fieldId: due.id,
        stops: [
          { color: 'red', value: null },
          { color: 'yellow', value: null },
          { color: 'green', value: null },
        ],
      },
    ]);
    expect((screen.getByRole('button', { name: 'Add color scale' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add color scale' }));
    expect(latest().colorScales.map((scale) => scale.fieldId)).toEqual([due.id, amount.id]);
    // Every field that can have a scale now has one.
    expect((screen.getByRole('button', { name: 'Add color scale' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove color scale' })[0]!);
    expect(latest().colorScales.map((scale) => scale.fieldId)).toEqual([amount.id]);
  });

  it('adds a data bar, hides its number, recolors it, and removes it', async () => {
    const latest = editor();
    await userEvent.click(screen.getByRole('button', { name: 'Add data bar' }));
    expect(latest().dataBars).toEqual([{ fieldId: amount.id, color: 'blue', showValue: true }]);
    expect((screen.getByRole('button', { name: 'Add data bar' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('switch', { name: 'Show the number' }));
    await choose(screen.getByRole('button', { name: /Bar color/ }), 'Teal');
    expect(latest().dataBars).toEqual([{ fieldId: amount.id, color: 'teal', showValue: false }]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove data bar' }));
    expect(latest().dataBars).toEqual([]);
  });

  it('warns about scales and bars on fields that can’t have them', () => {
    editor({
      colorScales: [{ fieldId: name.id, stops: [{ color: 'red' }, { color: 'green' }] }],
      dataBars: [{ fieldId: due.id }],
    });
    for (const text of ['This field can’t have a color scale.', 'This field can’t have a data bar.'])
      expect(screen.getByText(text).getAttribute('aria-hidden')).toBe('false');
  });
});

describe('the Color button', () => {
  it.each(['text', 'time'])(
    'keeps Enter inside a %s value and lets Escape close its dialog',
    async (type) => {
      const field = FieldMeta.parse({ ...name, type, options: {} });
      function Host() {
        const [config, setConfig] = useState(() =>
          GridConfig.parse({
            colorRules: [
              {
                ...rule('a', 'red', 1),
                condition: { id: 'value', fieldId: field.id, operator: 'is' },
              },
            ],
          }),
        );
        return (
          <ViewToolbar
            config={config}
            fields={[field]}
            primaryFieldId={field.id}
            colorable
            onConfigChange={(patch) => setConfig((current) => ({ ...current, ...patch }))}
          />
        );
      }
      mount(<Host />);
      await userEvent.click(screen.getByRole('button', { name: '1 color rule' }));
      const dialog = screen.getByRole('dialog', { name: '1 color rule' });
      await userEvent.type(within(dialog).getByRole('textbox', { name: 'Value' }), '14:30{Enter}');
      expect(screen.getByRole('dialog', { name: '1 color rule' })).toBe(dialog);
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '1 color rule' })).toBeNull());
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '1 color rule' }));
    },
  );

  function toolbar(config: unknown, props: { readOnly?: boolean; colorable?: boolean } = {}) {
    const changed = vi.fn();
    mount(
      <ViewToolbar
        config={GridConfig.parse(config)}
        fields={fields}
        primaryFieldId={name.id}
        colorable
        onConfigChange={changed}
        {...props}
      />,
    );
    return changed;
  }

  it('counts rules, scales, and bars, and opens the panel', async () => {
    const changed = toolbar({
      colorRules: [rule('a', 'red', 1)],
      dataBars: [{ fieldId: amount.id }],
    });
    const button = screen.getByRole('button', { name: '2 color rules' });
    expect(button.hasAttribute('data-active')).toBe(true);
    await userEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: '2 color rules' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove data bar' }));
    expect(changed).toHaveBeenLastCalledWith({ dataBars: [] });
  });

  it('reads Color without settings, and is left out for people who can’t edit the view', () => {
    toolbar({});
    expect(screen.getByRole('button', { name: 'Color' }).hasAttribute('data-active')).toBe(false);
    cleanup();
    toolbar({ colorRules: [rule('a', 'red', 1)] }, { readOnly: true });
    expect(screen.queryByRole('button', { name: /color/i })).toBeNull();
    cleanup();
    toolbar({}, { colorable: false });
    expect(screen.queryByRole('button', { name: 'Color' })).toBeNull();
  });
});
