import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { FieldSpec, newId } from '@riosoma/contracts';
import { openDatabase, type DatabaseSession } from '../../../data';
import { FakeServer } from '../../../data/testing';
import { FieldDialog } from './FieldDialog';
import { renderField, selectOption } from './fieldTestUtils';
import { FIELD_TYPE_INFO } from './fieldTypes';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
});

async function setup() {
  const server = new FakeServer();
  const fixture = server.createDatabase();
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  const id = newId('field');
  renderField(
    <FieldDialog
      mode="create"
      tableId={fixture.tableId}
      schema={session.getSchema()}
      existingNames={[]}
      isSaving={false}
      onCancel={() => {}}
      onSubmit={({ name, description, spec }) =>
        session.run([
          { kind: 'field.create', tableId: fixture.tableId, field: { id, name, description, ...spec } },
        ])
      }
    />,
  );
  return { saved: () => server.database(fixture.databaseId).schema.fields.find((field) => field.id === id) };
}

describe('additional field configuration', () => {
  it('orders the new types beside their related fields', () => {
    const types = FIELD_TYPE_INFO.map((field) => field.type);
    expect(types.slice(types.indexOf('number'), types.indexOf('number') + 4)).toEqual([
      'number',
      'currency',
      'percent',
      'duration',
    ]);
    expect(types[types.indexOf('checkbox') + 1]).toBe('rating');
    expect(types[types.indexOf('multipleSelect') + 1]).toBe('user');
    expect(types[types.indexOf('recordId') + 1]).toBe('autoNumber');
  });
  it('searches currencies by localized name and saves code, decimals, and negative permission', async () => {
    const f = await setup();
    await selectOption('Type', 'Currency');
    const input = screen.getByRole('combobox', { name: 'Currency' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Euro');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await selectOption('Decimal places', '3 (1.000)');
    await userEvent.click(screen.getByRole('switch', { name: 'Negative numbers' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() =>
      expect(f.saved()).toMatchObject({
        type: 'currency',
        options: { code: 'EUR', precision: 3, allowNegative: false },
      }),
    );
  });
  it('saves percent decimal places and negative permission', async () => {
    const f = await setup();
    await selectOption('Type', 'Percent');
    await selectOption('Decimal places', '2 (1.00)');
    await userEvent.click(screen.getByRole('switch', { name: 'Negative numbers' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() =>
      expect(f.saved()).toMatchObject({ type: 'percent', options: { precision: 2, allowNegative: false } }),
    );
  });
  it('shows every duration example and saves the chosen format', async () => {
    const f = await setup();
    await selectOption('Type', 'Duration');
    await userEvent.click(screen.getByRole('button', { name: /Format/ }));
    for (const example of [
      'h:mm (1:30)',
      'h:mm:ss (1:30:15)',
      'h:mm:ss.s (1:30:15.1)',
      'h:mm:ss.ss (1:30:15.13)',
      'h:mm:ss.sss (1:30:15.125)',
    ])
      expect(screen.getByRole('option', { name: example })).toBeDefined();
    await userEvent.click(screen.getByRole('option', { name: 'h:mm:ss.sss (1:30:15.125)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() =>
      expect(f.saved()).toMatchObject({ type: 'duration', options: { format: 'h:mm:ss.sss' } }),
    );
  });
  it('saves the rating maximum, icon, and color', async () => {
    const f = await setup();
    await selectOption('Type', 'Rating');
    await selectOption('Maximum', '10');
    await selectOption('Icon', 'Heart');
    await userEvent.click(screen.getByRole('radio', { name: 'Purple' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() =>
      expect(f.saved()).toMatchObject({
        type: 'rating',
        options: { max: 10, icon: 'heart', color: 'purple' },
      }),
    );
  });
  it('saves user multiplicity and notification preferences', async () => {
    const f = await setup();
    await selectOption('Type', 'User');
    await userEvent.click(screen.getByRole('switch', { name: 'Allow more than one person' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Notify people when they’re added' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() =>
      expect(f.saved()).toMatchObject({ type: 'user', options: { allowMultiple: true, notify: false } }),
    );
  });
  it('explains autonumber and saves an empty options object', async () => {
    const f = await setup();
    await selectOption('Type', 'Autonumber');
    expect(screen.getByText(/Numbers each record in the order it was created/)).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() => expect(f.saved()).toMatchObject(FieldSpec.parse({ type: 'autoNumber' })));
  });
});
