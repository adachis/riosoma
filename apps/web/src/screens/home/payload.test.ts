import { setupI18n } from '@lingui/core';
import { DatabaseCreate } from '@riosoma/contracts';
import { expect, it } from 'vitest';
import { newDatabasePayload } from './payload';

it('builds a valid database with localized defaults and unique identifiers', () => {
  const i18n = setupI18n({
    locale: 'fr',
    messages: {
      fr: {
        'home.default.table': 'Tableau 1',
        'home.default.view': 'Grille',
        'home.default.name': 'Nom',
        'home.default.notes': 'Remarques',
        'home.default.status': 'Statut',
        'home.default.todo': 'À faire',
        'home.default.inProgress': 'En cours',
        'home.default.done': 'Terminé',
      },
    },
  });
  const payload = newDatabasePayload({ name: ' Projets ', color: 'teal' }, (descriptor) =>
    i18n._(descriptor),
  );
  expect(DatabaseCreate.parse(payload)).toEqual(payload);
  expect(payload.name).toBe('Projets');
  expect(payload.table.name).toBe('Tableau 1');
  expect(payload.table.view.name).toBe('Grille');
  expect(payload.table.fields.map((field) => [field.name, field.type])).toEqual([
    ['Nom', 'text'],
    ['Remarques', 'longText'],
    ['Statut', 'singleSelect'],
  ]);
  const status = payload.table.fields[2]!;
  if (status.type !== 'singleSelect') throw new Error('Expected a single select field');
  expect(status.options.choices.map((choice) => [choice.name, choice.color])).toEqual([
    ['À faire', 'gray'],
    ['En cours', 'blue'],
    ['Terminé', 'green'],
  ]);
  expect(payload.table.records).toHaveLength(3);
  expect(payload.table.records.every((record) => Object.keys(record).length === 1)).toBe(true);
  const ids = [
    payload.id,
    payload.table.id,
    payload.table.view.id,
    ...payload.table.fields.map((field) => field.id),
    ...status.options.choices.map((choice) => choice.id),
    ...payload.table.records.map((record) => record.id),
  ];
  expect(new Set(ids).size).toBe(12);
  expect(
    newDatabasePayload({ name: 'Other', color: 'blue' }, (descriptor) => i18n._(descriptor)).id,
  ).not.toBe(payload.id);
});

it('uses the exact English default names without a catalog', () => {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const payload = newDatabasePayload({ name: 'Projects', color: 'blue' }, (descriptor) => i18n._(descriptor));
  expect(payload.table.name).toBe('Table 1');
  expect(payload.table.view.name).toBe('Grid');
  expect(payload.table.fields.map((field) => field.name)).toEqual(['Name', 'Notes', 'Status']);
  const field = payload.table.fields[2]!;
  expect(field.type === 'singleSelect' && field.options.choices.map((choice) => choice.name)).toEqual([
    'Todo',
    'In progress',
    'Done',
  ]);
});
