import { setupI18n } from '@lingui/core';
import { DatabaseSchema, newId } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { SchemaModel } from '../../../data/state';
import { VIEW_DEFINITIONS } from '../views/registry';
import { paletteItems } from './paletteItems';

const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });

const databaseId = newId('database');
const tasksId = newId('table');
const notesId = newId('table');
const weekId = newId('view');
const personId = newId('view');
const notesViewId = newId('view');
const fieldId = newId('field');
const boardId = newId('dashboard');
const botId = newId('automation');

const state = new SchemaModel(
  DatabaseSchema.parse({
    database: {
      id: databaseId,
      name: 'Projects',
      description: '',
      icon: null,
      color: null,
      createdBy: null,
      createdAt: '',
      updatedAt: '',
      role: 'owner',
    },
    tables: [
      {
        id: notesId,
        databaseId,
        name: 'Notes',
        description: '',
        primaryFieldId: fieldId,
        position: 1,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: tasksId,
        databaseId,
        name: 'Tasks',
        description: '',
        primaryFieldId: fieldId,
        position: 0,
        createdAt: '',
        updatedAt: '',
      },
    ],
    fields: [],
    views: [
      {
        id: notesViewId,
        tableId: notesId,
        name: 'All notes',
        type: 'grid',
        config: {},
        position: 0,
        createdBy: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: personId,
        tableId: tasksId,
        name: 'By person',
        type: 'kanban',
        config: {},
        position: 1,
        createdBy: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: weekId,
        tableId: tasksId,
        name: 'This week',
        type: 'grid',
        config: {},
        position: 0,
        createdBy: null,
        createdAt: '',
        updatedAt: '',
      },
    ],
    dashboards: [
      {
        id: boardId,
        databaseId,
        name: 'Progress',
        position: 0,
        config: { tiles: [] },
        createdAt: '',
        updatedAt: '',
      },
    ],
    automations: [
      {
        id: botId,
        databaseId,
        name: 'Welcome new tasks',
        position: 0,
        enabled: false,
        config: { trigger: { kind: 'recordCreated', tableId: tasksId }, conditions: null, steps: [] },
        runAsId: null,
        stoppedBecause: null,
        lastRunAt: null,
        createdAt: '',
        updatedAt: '',
      },
    ],
    collaborators: [],
    seq: 3,
  }),
).snapshot();

describe('what an open database offers the palette', () => {
  it('offers every table, view, dashboard, and automation, each with the path that opens it', () => {
    expect(
      paletteItems(state, databaseId, i18n).map(({ id, group, label, secondary, path }) => ({
        id,
        group,
        label,
        secondary,
        path,
      })),
    ).toEqual([
      {
        id: tasksId,
        group: 'tables',
        label: 'Tasks',
        secondary: 'Projects',
        path: `/${databaseId}/${tasksId}`,
      },
      {
        id: notesId,
        group: 'tables',
        label: 'Notes',
        secondary: 'Projects',
        path: `/${databaseId}/${notesId}`,
      },
      {
        id: weekId,
        group: 'views',
        label: 'This week',
        secondary: 'Tasks · Projects',
        path: `/${databaseId}/${tasksId}/${weekId}`,
      },
      {
        id: personId,
        group: 'views',
        label: 'By person',
        secondary: 'Tasks · Projects',
        path: `/${databaseId}/${tasksId}/${personId}`,
      },
      {
        id: notesViewId,
        group: 'views',
        label: 'All notes',
        secondary: 'Notes · Projects',
        path: `/${databaseId}/${notesId}/${notesViewId}`,
      },
      {
        id: boardId,
        group: 'dashboards',
        label: 'Progress',
        secondary: 'Projects',
        path: `/${databaseId}/dashboards/${boardId}`,
      },
      {
        id: botId,
        group: 'automations',
        label: 'Welcome new tasks',
        secondary: 'Projects',
        path: `/${databaseId}/automations/${botId}`,
      },
    ]);
  });

  it('gives a view the icon of the kind of view it is', () => {
    const items = paletteItems(state, databaseId, i18n);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(weekId)?.icon).toBe(VIEW_DEFINITIONS.grid.icon);
    expect(byId.get(personId)?.icon).toBe(VIEW_DEFINITIONS.kanban.icon);
    expect(byId.get(weekId)?.icon).not.toBe(byId.get(personId)?.icon);
  });

  it('offers a database with no views just its tables', () => {
    const empty = new SchemaModel({
      database: state.database,
      tables: [...state.tables],
      fields: [],
      views: [],
      collaborators: [],
      seq: 0,
    }).snapshot();
    expect(paletteItems(empty, databaseId, i18n).map((item) => item.group)).toEqual(['tables', 'tables']);
  });
});
