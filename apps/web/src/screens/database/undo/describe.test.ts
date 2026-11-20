import {
  AutomationMeta,
  Command,
  DashboardMeta,
  InterfaceMeta,
  newId,
  ScriptMeta,
  NamedFunctionMeta,
  type CommandKind,
  type DatabaseSchema,
} from '@riosoma/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { summarizeAction } from '../../../data/history';
import { SchemaModel } from '../../../data/state';
import { FakeServer } from '../../../data/testing';
import { seedTable } from '../../../grid/test-support';
import { i18n } from '../../../i18n';
import { describeAction } from './describe';

beforeAll(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});

/**
 * A Tasks table with a Status and a Notes field, a Grid view, a dashboard, an interface, an
 * automation, and a script.
 */
function schema() {
  const server = new FakeServer();
  const fixture = seedTable(
    server,
    [
      { name: 'Name', type: 'text' },
      { name: 'Status', type: 'text' },
      { name: 'Notes', type: 'text' },
    ],
    2,
    () => ({}),
  );
  const source: DatabaseSchema = structuredClone(fixture.database.schema);
  source.database.name = 'Work';
  source.tables[0]!.name = 'Tasks';
  const at = new Date(0).toISOString();
  const dashboard = DashboardMeta.parse({
    id: newId('dashboard'),
    databaseId: fixture.databaseId,
    name: 'Operations',
    position: 0,
    config: { tiles: [] },
    createdAt: at,
    updatedAt: at,
  });
  const workspace = InterfaceMeta.parse({
    id: newId('interface'),
    databaseId: fixture.databaseId,
    name: 'Front desk',
    position: 0,
    pages: [],
    createdAt: at,
    updatedAt: at,
  });
  const automation = AutomationMeta.parse({
    id: newId('automation'),
    databaseId: fixture.databaseId,
    name: 'Nightly',
    position: 0,
    enabled: false,
    config: { trigger: { kind: 'recordCreated', tableId: fixture.tableId } },
    runAsId: null,
    stoppedBecause: null,
    lastRunAt: null,
    createdAt: at,
    updatedAt: at,
  });
  source.dashboards = [dashboard];
  source.interfaces = [workspace];
  source.automations = [automation];
  const script = ScriptMeta.parse({
    id: newId('script'),
    databaseId: fixture.databaseId,
    name: 'Tidy names',
    description: '',
    source: '',
    position: 0,
    createdAt: at,
    updatedAt: at,
  });
  source.scripts = [script];
  const namedFunction = NamedFunctionMeta.parse({
    id: newId('namedFunction'),
    databaseId: fixture.databaseId,
    name: 'NET',
    parameters: ['amount'],
    body: 'amount * 0.8',
    description: '',
    revision: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: at,
    updatedAt: at,
  });
  source.namedFunctions = [namedFunction];
  const [, status, notes] = fixture.ids as [string, string, string];
  return {
    model: new SchemaModel(source),
    tableId: fixture.tableId,
    viewId: fixture.viewId,
    status,
    notes,
    record: (index: number) => fixture.recordId(index),
    dashboardId: dashboard.id,
    interfaceId: workspace.id,
    automationId: automation.id,
    scriptId: script.id,
    functionId: namedFunction.id,
  };
}

const t = i18n._.bind(i18n);

describe('how the undo history words each kind of action', () => {
  const s = schema();
  const one = (input: Record<string, unknown>) =>
    Command.parse({ id: newId('command'), groupId: newId('action'), ...input });
  const cases: Array<[Record<string, unknown>[], string]> = [
    [
      [
        {
          kind: 'automation.notify',
          automationId: s.automationId,
          subjectId: newId('command'),
          notifications: [
            {
              recipientId: newId('user'),
              content: {
                databaseId: s.model.database.id,
                title: 'Review',
                message: '',
                link: '',
                tokens: {},
              },
            },
          ],
        },
      ],
      'Sent notifications for Nightly',
    ],
    [
      [
        {
          kind: 'record.attachFromUrl',
          tableId: s.tableId,
          recordId: s.record(0),
          fieldId: s.notes,
          url: 'https://files.example.test/report.pdf',
        },
      ],
      'Changed 1 cell in Tasks',
    ],
    [
      [
        {
          kind: 'namedFunction.create',
          functionId: newId('namedFunction'),
          definition: { name: 'GROSS', parameters: ['amount'], body: 'amount * 1.2' },
        },
      ],
      'Added the GROSS function',
    ],
    [
      [
        {
          kind: 'namedFunction.update',
          functionId: s.functionId,
          revision: 1,
          definition: { name: 'NET', parameters: ['amount'], body: 'amount * 0.9' },
        },
      ],
      'Changed the NET function',
    ],
    [[{ kind: 'namedFunction.delete', functionId: s.functionId, revision: 1 }], 'Deleted the NET function'],
    [
      [
        {
          kind: 'database.navigation',
          change: {
            kind: 'folder.create',
            folder: { id: 'planning', name: 'Planning', section: 'table', parentId: null, position: 0 },
          },
        },
      ],
      'Arranged the sidebar in Work',
    ],
    [
      [
        {
          kind: 'record.generateDocument',
          tableId: s.tableId,
          recordId: s.record(0),
          templateFieldId: s.notes,
          attachmentFieldId: s.notes,
          format: 'docx',
          filename: 'record.docx',
          values: {},
        },
      ],
      'Generated a document in Tasks',
    ],
    [
      [
        {
          kind: 'automation.calendarEvent',
          automationId: s.automationId,
          event: {
            provider: 'google-calendar',
            title: 'Review',
            start: '2026-10-01T09:00:00Z',
            end: '2026-10-01T10:00:00Z',
          },
        },
      ],
      'Changed a calendar event for Nightly',
    ],
    [[{ kind: 'button.run', fieldId: s.notes, recordId: s.record(0) }], 'Ran Notes'],
    [
      [{ kind: 'record.duplicate', tableId: s.tableId, recordIds: [s.record(0), s.record(1)] }],
      'Duplicated 2 records in Tasks',
    ],
    [
      [{ kind: 'field.duplicate', fieldId: s.status, newFieldId: newId('field'), name: 'Status copy' }],
      'Duplicated the Status field',
    ],
    [
      [{ kind: 'table.duplicate', tableId: s.tableId, newTableId: newId('table'), name: 'Tasks copy' }],
      'Duplicated the Tasks table',
    ],
    [
      [{ kind: 'record.setLock', tableId: s.tableId, recordIds: [s.record(0)], locked: true, reason: '' }],
      'Changed record locks in Tasks',
    ],
    [
      [
        {
          kind: 'record.update',
          tableId: s.tableId,
          records: [
            { id: s.record(0), values: { [s.status]: 'Done', [s.notes]: 'Soon' } },
            { id: s.record(1), values: { [s.notes]: 'Later' } },
          ],
        },
      ],
      'Changed 3 cells in Tasks',
    ],
    [
      [
        {
          kind: 'record.update',
          tableId: s.tableId,
          records: [{ id: s.record(0), values: { [s.notes]: 'x' } }],
        },
      ],
      'Changed 1 cell in Tasks',
    ],
    [
      [
        {
          kind: 'record.create',
          tableId: s.tableId,
          records: Array.from({ length: 12 }, () => ({ id: newId('record'), values: {} })),
        },
      ],
      'Added 12 records to Tasks',
    ],
    [
      [{ kind: 'record.trash', tableId: s.tableId, recordIds: [s.record(0), s.record(1)] }],
      'Deleted 2 records from Tasks',
    ],
    [
      [{ kind: 'record.restore', tableId: s.tableId, recordIds: [s.record(0)] }],
      'Restored 1 record in Tasks',
    ],
    [
      [{ kind: 'record.merge', tableId: s.tableId, recordId: s.record(0), mergeIds: [s.record(1)] }],
      'Merged 2 records in Tasks',
    ],
    [
      [
        {
          kind: 'record.move',
          tableId: s.tableId,
          viewId: s.viewId,
          recordIds: [s.record(1)],
          place: { before: s.record(0) },
        },
      ],
      'Moved 1 record in the Grid view',
    ],
    [
      [
        {
          kind: 'record.clearOverrides',
          tableId: s.tableId,
          records: [{ id: s.record(0), fieldIds: [s.status, s.notes] }],
        },
      ],
      'Used the source values in 2 cells in Tasks',
    ],
    [
      [
        {
          kind: 'field.create',
          tableId: s.tableId,
          field: { id: newId('field'), name: 'Owner', type: 'text' },
        },
      ],
      'Added the Owner field to Tasks',
    ],
    [[{ kind: 'field.update', fieldId: s.status, name: 'Stage' }], 'Renamed the Status field to Stage'],
    [[{ kind: 'field.update', fieldId: s.status, description: 'Where it is' }], 'Changed the Status field'],
    [
      [{ kind: 'field.convert', fieldId: s.status, to: { type: 'longText' } }],
      'Changed the type of the Status field',
    ],
    [[{ kind: 'field.trash', fieldId: s.status }], 'Deleted the Status field'],
    [[{ kind: 'field.restore', fieldId: s.status }], 'Restored the Status field'],
    [[{ kind: 'field.setPrimary', tableId: s.tableId, fieldId: s.notes }], 'Made Notes the primary field'],
    [
      [
        {
          kind: 'table.create',
          table: {
            id: newId('table'),
            name: 'Projects',
            fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
            view: { id: newId('view'), name: 'Grid' },
          },
        },
      ],
      'Added the Projects table',
    ],
    [[{ kind: 'table.update', tableId: s.tableId, name: 'Chores' }], 'Renamed the Tasks table to Chores'],
    [[{ kind: 'table.update', tableId: s.tableId, description: 'Everything' }], 'Changed the Tasks table'],
    [[{ kind: 'table.move', tableId: s.tableId, position: 2 }], 'Moved the Tasks table'],
    [[{ kind: 'table.trash', tableId: s.tableId }], 'Deleted the Tasks table'],
    [[{ kind: 'table.restore', tableId: s.tableId }], 'Restored the Tasks table'],
    [
      [{ kind: 'table.updateSource', tableId: s.tableId, settings: { everyMinutes: 60 } }],
      'Changed how Tasks syncs',
    ],
    [
      [
        {
          kind: 'view.create',
          view: { id: newId('view'), tableId: s.tableId, name: 'Board', type: 'kanban' },
        },
      ],
      'Added the Board view to Tasks',
    ],
    [[{ kind: 'view.update', viewId: s.viewId, name: 'Everything' }], 'Renamed the Grid view to Everything'],
    [[{ kind: 'view.update', viewId: s.viewId, config: { rowHeight: 'tall' } }], 'Changed the Grid view'],
    [[{ kind: 'view.move', viewId: s.viewId, position: 3 }], 'Moved the Grid view'],
    [[{ kind: 'view.trash', viewId: s.viewId }], 'Deleted the Grid view'],
    [[{ kind: 'view.restore', viewId: s.viewId }], 'Restored the Grid view'],
    [[{ kind: 'database.update', name: 'Home' }], 'Renamed the database to Home'],
    [[{ kind: 'database.update', description: 'Our work' }], 'Changed the database'],
    [
      [{ kind: 'database.update', theme: { id: 'bauhaus', scheme: 'midnight' } }],
      'Changed the database’s theme',
    ],
    [[{ kind: 'database.update', theme: null }], 'Changed the database’s theme'],
    [[{ kind: 'database.trash' }], 'Deleted the database'],
    [[{ kind: 'database.restore' }], 'Restored the database'],
    [
      [{ kind: 'dashboard.create', dashboard: { id: newId('dashboard'), name: 'Weekly' } }],
      'Added the Weekly dashboard',
    ],
    [
      [{ kind: 'dashboard.update', dashboardId: s.dashboardId, name: 'Monthly' }],
      'Renamed the Operations dashboard to Monthly',
    ],
    [
      [{ kind: 'dashboard.update', dashboardId: s.dashboardId, config: { tiles: [] } }],
      'Changed the Operations dashboard',
    ],
    [[{ kind: 'dashboard.move', dashboardId: s.dashboardId, position: 1 }], 'Moved the Operations dashboard'],
    [[{ kind: 'dashboard.trash', dashboardId: s.dashboardId }], 'Deleted the Operations dashboard'],
    [[{ kind: 'dashboard.restore', dashboardId: s.dashboardId }], 'Restored the Operations dashboard'],
    [
      [{ kind: 'interface.create', interface: { id: newId('interface'), name: 'Intake' } }],
      'Added the Intake interface',
    ],
    [
      [{ kind: 'interface.update', interfaceId: s.interfaceId, name: 'Reception' }],
      'Renamed the Front desk interface to Reception',
    ],
    [
      [{ kind: 'interface.update', interfaceId: s.interfaceId, pages: [] }],
      'Changed the Front desk interface',
    ],
    [[{ kind: 'interface.move', interfaceId: s.interfaceId, position: 1 }], 'Moved the Front desk interface'],
    [[{ kind: 'interface.trash', interfaceId: s.interfaceId }], 'Deleted the Front desk interface'],
    [[{ kind: 'interface.restore', interfaceId: s.interfaceId }], 'Restored the Front desk interface'],
    [
      [
        {
          kind: 'automation.create',
          automation: {
            id: newId('automation'),
            name: 'Remind',
            config: { trigger: { kind: 'recordCreated', tableId: s.tableId } },
          },
        },
      ],
      'Added the Remind automation',
    ],
    [
      [{ kind: 'automation.update', automationId: s.automationId, name: 'Weekly' }],
      'Renamed the Nightly automation to Weekly',
    ],
    [
      [{ kind: 'automation.update', automationId: s.automationId, enabled: true }],
      'Changed the Nightly automation',
    ],
    [
      [{ kind: 'automation.move', automationId: s.automationId, position: 2 }],
      'Moved the Nightly automation',
    ],
    [[{ kind: 'automation.publish', automationId: s.automationId }], 'Published the Nightly automation'],
    [
      [{ kind: 'automation.discardDraft', automationId: s.automationId }],
      'Discarded the Nightly automation’s draft',
    ],
    [
      [{ kind: 'automation.restoreVersion', automationId: s.automationId, version: 1 }],
      'Restored an earlier version of the Nightly automation',
    ],
    [[{ kind: 'automation.trash', automationId: s.automationId }], 'Deleted the Nightly automation'],
    [[{ kind: 'automation.restore', automationId: s.automationId }], 'Restored the Nightly automation'],
    [
      [{ kind: 'automation.cancelRun', automationId: s.automationId, runId: newId('job') }],
      'Changed a waiting run of the Nightly automation',
    ],
    [
      [{ kind: 'script.create', script: { id: newId('script'), name: 'Count tasks' } }],
      'Added the Count tasks script',
    ],
    [
      [{ kind: 'script.update', scriptId: s.scriptId, name: 'Tidy every name' }],
      'Renamed the Tidy names script to Tidy every name',
    ],
    [
      [{ kind: 'script.update', scriptId: s.scriptId, source: 'await output.text("tidy")' }],
      'Changed the Tidy names script',
    ],
    [[{ kind: 'script.move', scriptId: s.scriptId, position: 2 }], 'Moved the Tidy names script'],
    [[{ kind: 'script.trash', scriptId: s.scriptId }], 'Deleted the Tidy names script'],
    [[{ kind: 'script.restore', scriptId: s.scriptId }], 'Restored the Tidy names script'],
    // An action that made several changes is named by the one that says the most.
    [
      [
        { kind: 'field.update', fieldId: s.status, options: {} },
        {
          kind: 'record.update',
          tableId: s.tableId,
          records: [{ id: s.record(0), values: { [s.status]: 'x' } }],
        },
      ],
      'Changed 1 cell in Tasks',
    ],
    [
      [
        {
          kind: 'record.update',
          tableId: s.tableId,
          records: [{ id: s.record(0), values: { [s.notes]: 'x' } }],
        },
        {
          kind: 'record.create',
          tableId: s.tableId,
          records: [
            { id: newId('record'), values: {} },
            { id: newId('record'), values: {} },
          ],
        },
      ],
      'Added 2 records to Tasks',
    ],
    // A large change is sent in several commands, which count together.
    [
      [
        { kind: 'record.trash', tableId: s.tableId, recordIds: [s.record(0)] },
        { kind: 'record.trash', tableId: s.tableId, recordIds: [s.record(1)] },
      ],
      'Deleted 2 records from Tasks',
    ],
  ];

  it.each(cases.map(([inputs, expected]) => [expected, inputs] as const))(
    'reads “%s”',
    (expected, inputs) => {
      const summary = summarizeAction(inputs.map(one), s.model);
      expect(summary).not.toBeNull();
      expect(describeAction(summary!, t)).toBe(expected);
    },
  );

  it('names a script run’s writes for the script', () => {
    expect(describeAction({ kind: 'script.run', count: 3, name: 'Tidy names' }, t)).toBe(
      'Ran the Tidy names script',
    );
  });

  it('covers every kind of change that undo can take back', () => {
    const named = new Set<CommandKind>(cases.flatMap(([inputs]) => inputs.map((input) => one(input).kind)));
    const undoable = Command.options
      .map((option) => option.shape.kind.value)
      .filter((kind) => kind !== 'table.sync' && !kind.startsWith('comment.'));
    expect(undoable.filter((kind) => !named.has(kind))).toEqual([]);
  });
});
