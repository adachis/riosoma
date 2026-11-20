import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldSpec, operatorsForField } from '@riosoma/contracts';
import { FakeServer } from '../../../data/testing';
import { relationalFixture } from '../../../data/testing/relational';
import { openDatabase } from '../../../data';
import { renderField } from '../fields/fieldTestUtils';
import { FilterValueEditor } from './FilterValueEditor';
import { SortEditor } from './SortEditor';

afterEach(cleanup);
describe('relational filters and sorts', () => {
  it('uses number, boolean, date, and text controls for computed results', async () => {
    const f = relationalFixture(new FakeServer());
    for (const [resultType, operator, role] of [
      ['number', 'gt', 'textbox'],
      ['boolean', 'is', 'radiogroup'],
      ['date', 'isBefore', 'button'],
      ['text', 'contains', 'textbox'],
    ] as const) {
      const field = { ...f.formula, ...FieldSpec.parse({ type: 'formula', options: { resultType } }) };
      expect(operatorsForField(field)).toContain(operator);
      renderField(
        <FilterValueEditor
          field={field}
          condition={{ id: 'condition', fieldId: field.id, operator }}
          collaborators={new Map()}
          readOnly={false}
          onChange={() => {}}
        />,
      );
      const control = screen.getByRole(role, { name: /Value/ });
      expect(control).toBeTruthy();
      if (resultType === 'number') expect(control.getAttribute('inputmode')).toBe('numeric');
      cleanup();
    }
    expect(operatorsForField(f.lookup)).toContain('gt');
    expect(operatorsForField(f.rollup)).toContain('gt');
    expect(operatorsForField(f.count)).toContain('gt');
  });

  it('offers text matching and picked records for links', async () => {
    const server = new FakeServer();
    const f = relationalFixture(server);
    const session = await openDatabase(f.source.databaseId, server.deps());
    try {
      const onChange = vi.fn();
      const base = { field: f.link, collaborators: new Map(), readOnly: false, onChange, session };
      renderField(
        <FilterValueEditor
          {...base}
          condition={{ id: 'condition', fieldId: f.link.id, operator: 'contains' }}
        />,
      );
      fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: 'Al' } });
      expect(onChange).toHaveBeenLastCalledWith('Al');
      cleanup();
      renderField(
        <FilterValueEditor
          {...base}
          condition={{ id: 'condition', fieldId: f.link.id, operator: 'hasAnyOf' }}
        />,
      );
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Alpha' } });
      await userEvent.click(await screen.findByRole('option', { name: 'Alpha' }));
      expect(onChange).toHaveBeenLastCalledWith([f.recordIds[0]]);
    } finally {
      session.close();
    }
  });

  it('disables formulas that the server cannot sort', async () => {
    const f = relationalFixture(new FakeServer());
    const field = { ...f.formula, ...FieldSpec.parse({ type: 'formula', options: { sortable: false } }) };
    const onChange = vi.fn();
    renderField(
      <SortEditor
        fields={[f.title, field]}
        value={[{ fieldId: f.title.id, direction: 'asc' }]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Field/ }));
    const option = screen.getByRole('option', { name: /Double/ });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
  });
});
