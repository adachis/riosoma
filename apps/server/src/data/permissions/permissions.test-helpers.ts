import { expect } from 'vitest';
import {
  CURRENT_PERSON,
  newId,
  type CommandBatchResult,
  type CommandResult,
  type DatabaseSchema,
  type TokenCreated,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { ServerFixture, SignedIn } from '../../test/fixture.js';

/**
 * A database for permission tests.  People has a restricted field (Salary), a formula over it
 * (Bonus), a locked field (Notes), and record rules: editors, and one creator by name, see only
 * West records, and Pat sees only records Pat owns.  Teams links to People, with a lookup and a
 * rollup of Salary, which are hidden wherever Salary is, and a count and a lookup of names, which
 * count only the records each person may see.
 *
 * Ana is in the West and owned by Pat.  Zanzibar and Zulu are in the East and owned by nobody, so
 * a person the rules limit never sees either.  Every value a restricted field or a hidden record
 * holds is distinctive, so a test can look for it in anything a person receives.
 */

export const SALARY = { ana: 987654.25, zanzibar: 555111.5, zulu: 444222.75 } as const;

/** Text that only a person who sees Salary may ever receive */
export const SALARY_SENTINELS = [
  '987654',
  '555111',
  '444222',
  // Bonus, which is Salary doubled
  '1975308',
  '1110223',
  '888445',
  // Payroll, the rollup of Salary over Alpha's live people
  '1986988',
  // The same, as downloads and reports word them
  '987,654',
  '555,111',
  '444,222',
  '1,975,308',
  '1,110,223',
  '888,445',
  '1,986,988',
  'Salary',
  'Bonus',
  'Team salaries',
  'Payroll',
  'Old salary note',
] as const;

export interface Person {
  label: string;
  signed: SignedIn;
  role: 'owner' | 'creator' | 'editor' | 'commenter' | 'reader';
  /** Whether Salary, and everything computed from it, is theirs to see */
  seesSalary: boolean;
  /** Whether they see every record of People, or only Ana */
  seesAllRecords: boolean;
}

export interface PermissionFixture {
  databaseId: string;
  people: {
    tableId: string;
    viewId: string;
    chartViewId: string;
    formViewId: string;
    fields: {
      name: string;
      salary: string;
      bonus: string;
      notes: string;
      region: string;
      owner: string;
      team: string;
      oldNote: string;
    };
    choices: { west: string; east: string };
    records: { ana: string; zanzibar: string; zulu: string; trashed: string };
  };
  teams: {
    tableId: string;
    viewId: string;
    fields: {
      name: string;
      people: string;
      salaries: string;
      payroll: string;
      headcount: string;
      names: string;
    };
    records: { alpha: string };
  };
  persons: Record<
    'owner' | 'hr' | 'creator' | 'limitedCreator' | 'editor' | 'lead' | 'reader' | 'pat',
    Person
  >;
}

/** Text only people who see every People record may receive: the East records and their values */
export function hiddenRecordSentinels(f: PermissionFixture): string[] {
  return [
    f.people.records.zanzibar,
    f.people.records.zulu,
    f.people.records.trashed,
    'Zanzibar',
    'Zulu',
    'East secret',
  ];
}

/** Every sentinel a person must never receive. */
export function forbiddenFor(f: PermissionFixture, person: Person): string[] {
  return [
    ...(person.seesSalary ? [] : SALARY_SENTINELS),
    ...(person.seesAllRecords ? [] : hiddenRecordSentinels(f)),
  ];
}

/** The sentinels in some text, for an assertion that names what leaked. */
export function leaks(text: string, sentinels: readonly string[]): string[] {
  return sentinels.filter((sentinel) => text.includes(sentinel));
}

export async function inject(
  server: ServerFixture,
  who: SignedIn,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return server.app.inject({
    method,
    url,
    headers: who.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

export async function command(
  server: ServerFixture,
  who: SignedIn,
  databaseId: string,
  input: Record<string, unknown>,
): Promise<CommandResult> {
  const response = await inject(server, who, 'POST', `/api/databases/${databaseId}/commands`, {
    clientId: newId('client'),
    commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommandBatchResult>().results[0]!;
}

export async function applied(
  server: ServerFixture,
  who: SignedIn,
  databaseId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const result = await command(server, who, databaseId, input);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

async function grant(server: ServerFixture, databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

export async function schemaOf(server: ServerFixture, who: SignedIn, databaseId: string) {
  const response = await inject(server, who, 'GET', `/api/databases/${databaseId}/schema`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<DatabaseSchema>();
}

export async function tokenFor(server: ServerFixture, who: SignedIn): Promise<TokenCreated> {
  const response = await inject(server, who, 'POST', '/api/tokens', {
    name: 'Permissions',
    scopes: ['schema.bases:read', 'data.records:read', 'data.records:write'],
    databases: 'all',
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TokenCreated>();
}

export async function permissionFixture(server: ServerFixture): Promise<PermissionFixture> {
  const owner = server.owner;
  const people = { tableId: newId('table'), viewId: newId('view') };
  const teams = { tableId: newId('table'), viewId: newId('view') };
  const fields = {
    name: newId('field'),
    salary: newId('field'),
    bonus: newId('field'),
    notes: newId('field'),
    region: newId('field'),
    owner: newId('field'),
    team: newId('field'),
    oldNote: newId('field'),
  };
  const teamFields = {
    name: newId('field'),
    salaries: newId('field'),
    payroll: newId('field'),
    headcount: newId('field'),
    names: newId('field'),
  };
  const choices = { west: newId('choice'), east: newId('choice') };
  const records = {
    ana: newId('record'),
    zanzibar: newId('record'),
    zulu: newId('record'),
    trashed: newId('record'),
  };
  const alpha = newId('record');
  const databaseId = newId('database');

  const created = await inject(server, owner, 'POST', '/api/databases', {
    id: databaseId,
    name: 'Company',
    table: {
      id: people.tableId,
      name: 'People',
      fields: [{ id: fields.name, name: 'Name', type: 'text' }],
      view: { id: people.viewId, name: 'Everyone' },
      records: [],
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const run = (input: Record<string, unknown>) => applied(server, owner, databaseId, input);
  const field = (tableId: string, id: string, name: string, type: string, options: unknown = {}) =>
    run({ kind: 'field.create', tableId, field: { id, name, type, description: '', options } });

  await run({
    kind: 'table.create',
    table: {
      id: teams.tableId,
      name: 'Teams',
      fields: [{ id: teamFields.name, name: 'Team name', type: 'text' }],
      view: { id: teams.viewId, name: 'Teams' },
      records: [],
    },
  });
  await field(people.tableId, fields.salary, 'Salary', 'number', { precision: 2 });
  await field(people.tableId, fields.notes, 'Notes', 'text');
  await field(people.tableId, fields.region, 'Region', 'singleSelect', {
    choices: [
      { id: choices.west, name: 'West', color: 'blue' },
      { id: choices.east, name: 'East', color: 'red' },
    ],
  });
  await field(people.tableId, fields.owner, 'Owner', 'user');
  await field(people.tableId, fields.oldNote, 'Old salary note', 'text');
  await field(people.tableId, fields.bonus, 'Bonus', 'formula', { expression: '{Salary} * 2' });
  await field(people.tableId, fields.team, 'Team', 'link', { linkedTableId: teams.tableId });
  const inverse = (await schemaOf(server, owner, databaseId)).fields.find(
    (item) => item.tableId === teams.tableId && item.type === 'link',
  )!.id;
  await field(teams.tableId, teamFields.salaries, 'Team salaries', 'lookup', {
    linkFieldId: inverse,
    targetFieldId: fields.salary,
  });
  await field(teams.tableId, teamFields.payroll, 'Payroll', 'rollup', {
    linkFieldId: inverse,
    targetFieldId: fields.salary,
    fn: 'sum',
  });
  await field(teams.tableId, teamFields.headcount, 'Headcount', 'count', { linkFieldId: inverse });
  await field(teams.tableId, teamFields.names, 'Member names', 'lookup', {
    linkFieldId: inverse,
    targetFieldId: fields.name,
  });

  const persons = {
    owner: { label: 'owner', signed: owner, role: 'owner', seesSalary: true, seesAllRecords: true },
    hr: {
      label: 'creator named by the restriction',
      signed: await server.addMember({ name: 'Hana Hr' }),
      role: 'creator',
      seesSalary: true,
      seesAllRecords: true,
    },
    creator: {
      label: 'creator',
      signed: await server.addMember({ name: 'Cal Creator' }),
      role: 'creator',
      seesSalary: false,
      seesAllRecords: true,
    },
    limitedCreator: {
      label: 'creator named by a record rule',
      signed: await server.addMember({ name: 'Lin Limited' }),
      role: 'creator',
      seesSalary: false,
      seesAllRecords: false,
    },
    editor: {
      label: 'editor inside the West rule',
      signed: await server.addMember({ name: 'Eddie Editor' }),
      role: 'editor',
      seesSalary: false,
      seesAllRecords: false,
    },
    lead: {
      label: 'editor who may change Notes',
      signed: await server.addMember({ name: 'Lee Lead' }),
      role: 'editor',
      seesSalary: false,
      seesAllRecords: false,
    },
    reader: {
      label: 'reader outside every rule',
      signed: await server.addMember({ name: 'Rae Reader' }),
      role: 'reader',
      seesSalary: false,
      seesAllRecords: true,
    },
    pat: {
      label: 'reader inside the owner rule',
      signed: await server.addMember({ name: 'Pat Person' }),
      role: 'reader',
      seesSalary: false,
      seesAllRecords: false,
    },
  } satisfies PermissionFixture['persons'];
  for (const person of Object.values(persons))
    if (person.role !== 'owner') await grant(server, databaseId, person.signed, person.role);

  await run({
    kind: 'record.create',
    tableId: teams.tableId,
    records: [{ id: alpha, values: { [teamFields.name]: 'Alpha' } }],
  });
  const person = (
    id: string,
    name: string,
    salary: number,
    region: string,
    notes: string,
    ownerIds: string[],
  ) => ({
    id,
    values: {
      [fields.name]: name,
      [fields.salary]: salary,
      [fields.region]: region,
      [fields.notes]: notes,
      [fields.owner]: ownerIds,
      [fields.oldNote]: `note ${salary}`,
      [fields.team]: [alpha],
    },
  });
  await run({
    kind: 'record.create',
    tableId: people.tableId,
    records: [
      person(records.ana, 'Ana West', SALARY.ana, choices.west, 'Ana notes', [persons.pat.signed.userId]),
      person(records.zanzibar, 'Zanzibar East', SALARY.zanzibar, choices.east, 'East secret', []),
      person(records.zulu, 'Zulu East', SALARY.zulu, choices.east, 'East secret two', []),
      person(records.trashed, 'Zulu Trashed', 1, choices.east, 'East secret three', []),
    ],
  });
  await run({ kind: 'record.trash', tableId: people.tableId, recordIds: [records.trashed] });

  // Views: the grid sums Salary in its summary row, a chart counts people by name, and a form asks
  // for Salary and Notes.
  await run({
    kind: 'view.update',
    viewId: people.viewId,
    config: { summaries: { [fields.salary]: 'sum', [fields.name]: 'count' } },
  });
  const chartViewId = newId('view');
  await run({
    kind: 'view.create',
    view: {
      id: chartViewId,
      tableId: people.tableId,
      name: 'By name',
      type: 'chart',
      config: {
        chart: { groupBy: { fieldId: fields.name, dateBucket: null }, value: { fn: 'count', fieldId: null } },
      },
    },
  });
  const formViewId = newId('view');
  await run({
    kind: 'view.create',
    view: {
      id: formViewId,
      tableId: people.tableId,
      name: 'Join us',
      type: 'form',
      config: {
        form: {
          questions: [
            { fieldId: fields.name, label: '', help: '', required: true },
            { fieldId: fields.salary, label: '', help: '', required: false },
            { fieldId: fields.notes, label: '', help: '', required: false },
          ],
        },
      },
    },
  });

  const fixture: PermissionFixture = {
    databaseId,
    people: { ...people, chartViewId, formViewId, fields, choices, records },
    teams: {
      ...teams,
      fields: { ...teamFields, people: inverse },
      records: { alpha },
    },
    persons,
  };

  // The rules, through their own routes.
  const put = async (url: string, body: unknown) => {
    const response = await inject(server, owner, 'PUT', url, body);
    expect(response.statusCode, response.body).toBe(200);
  };
  await put(`/api/fields/${fields.salary}/permissions`, {
    restricted: { roles: [], users: [persons.hr.signed.userId] },
    locked: null,
  });
  await put(`/api/fields/${fields.oldNote}/permissions`, {
    restricted: { roles: [], users: [persons.hr.signed.userId] },
    locked: null,
  });
  await put(`/api/fields/${fields.notes}/permissions`, {
    restricted: null,
    locked: { roles: ['creator'], users: [persons.lead.signed.userId] },
  });
  await put(`/api/tables/${people.tableId}/record-rules`, {
    rules: [
      {
        id: newId('recordRule'),
        roles: ['editor'],
        users: [persons.limitedCreator.signed.userId],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'west', fieldId: fields.region, operator: 'is', value: choices.west }],
        },
      },
      {
        id: newId('recordRule'),
        roles: [],
        users: [persons.pat.signed.userId],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'mine', fieldId: fields.owner, operator: 'hasAnyOf', value: [CURRENT_PERSON] }],
        },
      },
    ],
  });
  // A restricted field in the trash, so the trash has something to keep from people.
  await run({ kind: 'field.trash', fieldId: fields.oldNote });
  return fixture;
}
