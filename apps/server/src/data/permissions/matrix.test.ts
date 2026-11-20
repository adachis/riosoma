import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId, type TokenCreated } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { databaseSchema } from '../../ai/tools.js';
import { reportRead, renderReport } from '../../reports/render.js';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { AccessScope } from '../access.js';
import { findRecords } from '../commands/index.js';
import { SnapshotCache } from '../snapshots.js';
import {
  applied,
  forbiddenFor,
  inject,
  leaks,
  permissionFixture,
  tokenFor,
  type PermissionFixture,
  type Person,
} from './permissions.test-helpers.js';

/**
 * The generated authorization matrix: every read path, as every kind of person, with nothing a
 * rule hides from them in anything they receive.  Each path has a control, something the owner
 * does receive, and the last test shows every path leaking once the rules stop applying, so no
 * path passes here by reading nothing at all.
 */

let kit: TestPostgres;
let server: ServerFixture;
let address: string;
let f: PermissionFixture;
let dashboardId: string;
let interfaceId: string;
let automationId: string;
const tokens = new Map<string, TokenCreated>();
const mcpClients: Client[] = [];

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'permmatrix');
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  f = await permissionFixture(server);
  const owner = server.owner;
  const { people, teams } = f;

  dashboardId = newId('dashboard');
  const place = { x: 0, y: 0, w: 4, h: 2 };
  await applied(server, owner, f.databaseId, {
    kind: 'dashboard.create',
    dashboard: {
      id: dashboardId,
      name: 'People',
      config: {
        tiles: [
          {
            id: 'count-all',
            kind: 'number',
            place,
            source: { tableId: people.tableId },
            value: { fn: 'count' },
          },
          {
            id: 'salary-sum',
            kind: 'number',
            place,
            source: { tableId: people.tableId },
            value: { fn: 'sum', fieldId: people.fields.salary },
          },
          {
            id: 'by-name',
            kind: 'chart',
            place,
            source: { tableId: people.tableId },
            groupBy: { fieldId: people.fields.name },
            value: { fn: 'count' },
          },
          {
            id: 'people-list',
            kind: 'records',
            place,
            source: { tableId: people.tableId },
            fieldIds: [people.fields.name, people.fields.salary],
          },
          {
            id: 'team-list',
            kind: 'records',
            place,
            source: { tableId: teams.tableId },
            fieldIds: [teams.fields.name, teams.fields.payroll, teams.fields.people],
          },
        ],
      },
    },
  });

  interfaceId = newId('interface');
  await applied(server, owner, f.databaseId, {
    kind: 'interface.create',
    interface: {
      id: interfaceId,
      name: 'Directory',
      pages: [
        {
          id: 'page-one',
          name: 'People',
          blocks: [
            {
              id: 'block-list',
              kind: 'records',
              place,
              source: { tableId: people.tableId, viewId: people.viewId },
              fieldIds: [people.fields.name, people.fields.salary],
            },
            {
              id: 'block-sum',
              kind: 'number',
              place,
              source: { tableId: people.tableId },
              value: { fn: 'sum', fieldId: people.fields.salary },
            },
          ],
        },
      ],
    },
  });

  // A comment on a hidden record, mentioning everyone, as the owner.
  const everyone = Object.values(f.persons)
    .filter((person) => person.role !== 'owner')
    .map((person) => `@[${person.signed.info.user.name}](${person.signed.userId})`)
    .join(' ');
  await applied(server, owner, f.databaseId, {
    kind: 'comment.create',
    tableId: people.tableId,
    recordId: people.records.zanzibar,
    comment: { id: newId('comment'), body: `Zanzibar review ${everyone}` },
  });

  // An automation with a run whose steps read Salary from a hidden record.
  automationId = newId('automation');
  await applied(server, owner, f.databaseId, {
    kind: 'automation.create',
    automation: {
      id: automationId,
      name: 'Monthly check',
      config: {
        trigger: { kind: 'recordCreated', tableId: people.tableId },
        steps: [],
      },
    },
  });
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'automation_runs')}
      (id, automation_id, org_id, database_id, state, trigger_kind, record_id, steps, started_at, finished_at)
      VALUES (${newId('job')}, ${automationId}, ${server.owner.info.org.id}, ${f.databaseId}, 'succeeded',
        'recordCreated', ${people.records.zanzibar},
        ${JSON.stringify([
          {
            stepId: 'step1',
            state: 'succeeded',
            ms: 3,
            output: { record: { id: people.records.zanzibar, Name: 'Zanzibar East', Salary: 555111.5 } },
            error: null,
          },
        ])}::jsonb, now(), now())`,
  );
}, 180_000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await Promise.all(mcpClients.splice(0).map((client) => client.close()));
  await server?.close();
  await kit?.stop();
});

const everyone = (): Person[] => Object.values(f.persons);

async function get(person: Person, url: string, payload?: unknown): Promise<string> {
  const response = await inject(server, person.signed, payload === undefined ? 'GET' : 'POST', url, payload);
  return `${response.statusCode} ${response.body}`;
}

async function token(person: Person): Promise<TokenCreated> {
  let found = tokens.get(person.label);
  if (!found) {
    found = await tokenFor(server, person.signed);
    tokens.set(person.label, found);
  }
  return found;
}

async function rest(person: Person, url: string): Promise<string> {
  const response = await server.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${(await token(person)).token}` },
  });
  return `${response.statusCode} ${response.body}`;
}

async function mcp(person: Person, name: string, args: Record<string, unknown>): Promise<string> {
  const client = new Client({ name: 'permissions', version: '1.0.0' });
  mcpClients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${(await token(person)).token}` } },
    }),
  );
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return JSON.stringify(result);
}

function actorOf(person: Person) {
  return {
    userId: person.signed.userId,
    orgId: person.signed.info.org.id,
    sessionId: 'ses',
    kind: 'member' as const,
    adminRoles: [],
    csrfToken: '',
  };
}

interface ReadPath {
  name: string;
  read(person: Person): Promise<string>;
  /** What the control reads and must find, or false for paths with nothing the owner alone gets */
  control?: { person?: keyof PermissionFixture['persons']; sentinel: () => string } | false;
}

const PATHS: ReadPath[] = [
  {
    name: 'schema reads',
    read: (p) => get(p, `/api/databases/${f.databaseId}/schema`),
    control: { sentinel: () => 'Salary' },
  },
  {
    name: 'grid rows',
    read: (p) => get(p, `/api/views/${f.people.viewId}/rows?limit=100`),
    control: { sentinel: () => '987654' },
  },
  {
    name: 'grid rows of a table with lookups, rollups, counts, and links',
    read: (p) => get(p, `/api/views/${f.teams.viewId}/rows?limit=100`),
    control: { sentinel: () => f.people.records.zanzibar },
  },
  {
    name: 'one record',
    read: async (p) =>
      (await get(p, `/api/tables/${f.people.tableId}/records/${f.people.records.ana}`)) +
      (await get(p, `/api/tables/${f.people.tableId}/records/${f.people.records.zanzibar}`)) +
      (await get(p, `/api/tables/${f.teams.tableId}/records/${f.teams.records.alpha}`)),
    control: { sentinel: () => 'Zanzibar' },
  },
  {
    name: 'linked record names',
    read: (p) =>
      get(p, `/api/tables/${f.people.tableId}/records/names`, {
        ids: [f.people.records.ana, f.people.records.zanzibar],
      }),
    control: { sentinel: () => 'Zanzibar' },
  },
  {
    name: 'finding a record by name',
    read: (p) => get(p, `/api/tables/${f.people.tableId}/records/search?q=a`),
    control: { sentinel: () => 'Zanzibar' },
  },
  {
    name: 'search in a view',
    read: async (p) =>
      (await get(p, `/api/views/${f.people.viewId}/search`, { query: 'East' })) +
      (await get(p, `/api/views/${f.people.viewId}/search`, { query: '987654' })),
    control: { sentinel: () => f.people.records.zanzibar },
  },
  {
    name: 'a record’s place in a view',
    read: async (p) => {
      const response = await inject(
        server,
        p.signed,
        'GET',
        `/api/views/${f.people.viewId}/position?recordId=${f.people.records.zanzibar}`,
      );
      const body = response.json<{ index?: number | null }>();
      // A hidden record's place is as telling as its name.
      return response.statusCode === 200 && typeof body.index === 'number'
        ? `placed ${f.people.records.zanzibar}`
        : response.body;
    },
    control: { sentinel: () => f.people.records.zanzibar },
  },
  {
    name: 'downloads',
    read: async (p) =>
      (await get(p, `/api/views/${f.people.viewId}/export?format=csv&timeZone=UTC&locale=en-US`)) +
      (await get(p, `/api/views/${f.teams.viewId}/export?format=csv&timeZone=UTC&locale=en-US`)),
    control: { sentinel: () => '987,654' },
  },
  {
    name: 'a view’s summary row',
    read: (p) =>
      get(p, `/api/databases/${f.databaseId}/views/${f.people.viewId}/aggregate`, {
        timeZone: 'UTC',
        summary: true,
      }),
    control: { sentinel: () => '1986988' },
  },
  {
    name: 'charts',
    read: (p) =>
      get(p, `/api/databases/${f.databaseId}/views/${f.people.chartViewId}/aggregate`, { timeZone: 'UTC' }),
    control: { sentinel: () => 'Zanzibar' },
  },
  {
    name: 'dashboards',
    read: (p) => get(p, `/api/dashboards/${dashboardId}/data`, { timeZone: 'UTC' }),
    control: { sentinel: () => 'Zanzibar' },
  },
  {
    name: 'interfaces',
    read: async (p) =>
      (await get(p, `/api/interfaces/${interfaceId}/data`, { pageId: 'page-one', timeZone: 'UTC' })) +
      (await get(p, `/api/interfaces/${interfaceId}/records`, {
        pageId: 'page-one',
        blockId: 'block-list',
        offset: 0,
        limit: 50,
        timeZone: 'UTC',
      })),
    control: { sentinel: () => 'Zanzibar' },
  },
  {
    name: 'comments',
    read: (p) => get(p, `/api/tables/${f.people.tableId}/records/${f.people.records.zanzibar}/comments`),
    control: { sentinel: () => 'Zanzibar review' },
  },
  {
    name: 'history',
    read: async (p) =>
      (await get(p, `/api/tables/${f.people.tableId}/records/${f.people.records.ana}/history`)) +
      (await get(p, `/api/tables/${f.people.tableId}/records/${f.people.records.zanzibar}/history`)),
    control: { sentinel: () => '987654' },
  },
  {
    name: 'the trash',
    read: async (p) =>
      (await get(p, `/api/databases/${f.databaseId}/trash`)) +
      (await get(p, `/api/tables/${f.people.tableId}/trash/records`)),
    control: { sentinel: () => 'Zulu' },
  },
  {
    name: 'the REST API',
    read: async (p) =>
      (await rest(p, `/api/v1/tables/${f.people.tableId}/records`)) +
      (await rest(p, `/api/v1/tables/${f.teams.tableId}/records`)) +
      (await rest(p, `/api/v1/tables/${f.people.tableId}/records/${f.people.records.zanzibar}`)) +
      (await rest(p, `/api/v1/databases/${f.databaseId}/tables`)),
    control: { sentinel: () => '987654' },
  },
  {
    name: 'MCP tools',
    read: async (p) =>
      (await mcp(p, 'get_schema', { databaseId: f.databaseId })) +
      (await mcp(p, 'find_records', { tableId: f.people.tableId })) +
      (await mcp(p, 'find_records', { tableId: f.teams.tableId })) +
      (await mcp(p, 'get_record', { tableId: f.people.tableId, recordId: f.people.records.zanzibar })),
    control: { sentinel: () => '987654' },
  },
  {
    name: 'finding duplicates',
    read: (p) =>
      get(p, `/api/tables/${f.people.tableId}/duplicates`, {
        fields: [{ fieldId: f.people.fields.region, match: 'exact' }],
      }),
    control: { sentinel: () => f.people.records.zanzibar },
  },
  {
    name: 'join suggestions',
    read: (p) => get(p, `/api/databases/${f.databaseId}/join-suggestions`, {}),
    control: false,
  },
  {
    name: 'scheduled reports',
    read: async (p) => {
      const snapshots = new SnapshotCache(
        () => ({ pool: server.pool, schemas: server.schemas }),
        16,
        server.app.log,
      );
      const content = await renderReport({
        pool: server.pool,
        schemas: server.schemas,
        snapshots,
        scope: new AccessScope(server.pool, server.schemas, actorOf(p)),
        viewId: f.people.viewId,
        format: 'csv',
        locale: 'en-US',
        timeZone: 'UTC',
        limit: 1_000_000,
      });
      return JSON.stringify({
        ...content,
        attachment: content?.attachment ? String(content.attachment.content) : null,
      });
    },
    control: { sentinel: () => '987,654' },
  },
  {
    name: 'the AI tools',
    read: async (p) => JSON.stringify(await databaseSchema(server.app, actorOf(p), f.databaseId)),
    control: { sentinel: () => 'Salary' },
  },
  {
    name: 'automations and scripts finding records',
    read: async (p) =>
      JSON.stringify(await findRecords(server.app, actorOf(p), f.databaseId, { tableId: f.people.tableId })),
    control: { sentinel: () => '987654' },
  },
  {
    name: 'automation run history',
    read: (p) => get(p, `/api/automations/${automationId}/runs`),
    control: { sentinel: () => '555111' },
  },
  {
    name: 'notifications',
    // Mentions are decided when the comment is written, so each read writes one first.
    read: async (p) => {
      await applied(server, server.owner, f.databaseId, {
        kind: 'comment.create',
        tableId: f.people.tableId,
        recordId: f.people.records.zanzibar,
        comment: {
          id: newId('comment'),
          body: `Zanzibar ping @[${p.signed.info.user.name}](${p.signed.userId})`,
        },
      });
      return get(p, '/api/notifications');
    },
    control: { person: 'hr', sentinel: () => f.people.records.zanzibar },
  },
];

describe('the authorization matrix', () => {
  for (const path of PATHS) {
    it(`${path.name}: nobody receives what a rule hides from them`, async () => {
      for (const person of everyone()) {
        const body = await path.read(person);
        expect(leaks(body, forbiddenFor(f, person)), `${path.name} as the ${person.label}`).toEqual([]);
      }
      if (path.control) {
        const who = f.persons[path.control.person ?? 'owner'];
        const body = await path.read(who);
        expect(body, `${path.name} control`).toContain(path.control.sentinel());
      }
    });
  }

  it('reports reads through the same scope for a member and an owner', async () => {
    const snapshots = new SnapshotCache(
      () => ({ pool: server.pool, schemas: server.schemas }),
      16,
      server.app.log,
    );
    const read = await reportRead({
      pool: server.pool,
      schemas: server.schemas,
      snapshots,
      scope: new AccessScope(server.pool, server.schemas, actorOf(f.persons.editor)),
      viewId: f.people.viewId,
      timeZone: 'UTC',
    });
    expect(read?.fields.map((field) => field.id)).not.toContain(f.people.fields.salary);
  });
});

describe('testing one automation step', () => {
  it('reads with the access of the person testing, never the owner’s', async () => {
    const id = newId('automation');
    await applied(server, server.owner, f.databaseId, {
      kind: 'automation.create',
      automation: {
        id,
        name: 'Step check',
        config: {
          trigger: { kind: 'recordCreated', tableId: f.people.tableId },
          steps: [
            {
              id: 'step01',
              kind: 'script',
              input: {},
              script: `await output(await records.find('${f.people.tableId}'))`,
            },
          ],
        },
      },
    });
    // Turned on by the owner, it acts as the owner.
    await applied(server, server.owner, f.databaseId, {
      kind: 'automation.update',
      automationId: id,
      enabled: true,
    });
    for (const person of [f.persons.limitedCreator, f.persons.creator]) {
      const tested = await get(person, `/api/automations/${id}/steps/step01/test`, {});
      expect(tested).toMatch(/^200 /);
      expect(tested).toContain('"state":"succeeded"');
      expect(tested).toContain(f.people.records.ana);
      expect(leaks(tested, forbiddenFor(f, person))).toEqual([]);
    }
    const owner = await get(f.persons.owner, `/api/automations/${id}/steps/step01/test`, {});
    expect(owner).toMatch(/^200 /);
    expect(owner).toContain('Zanzibar');
    expect(owner).toContain('555111');
  });
});

describe('without the scope', () => {
  it('every path leaks, so each test above depends on the rules', async () => {
    const permissive = AccessScope.prototype;
    vi.spyOn(permissive, 'visibleFields').mockImplementation(function <F extends { id: string }>(
      _tableId: string,
      fields: readonly F[],
    ) {
      return [...fields];
    });
    vi.spyOn(permissive, 'recordPredicate').mockImplementation(() => sql`TRUE`);
    vi.spyOn(permissive, 'limitsRecords').mockReturnValue(false);
    vi.spyOn(permissive, 'hiddenFieldIds').mockReturnValue(new Set());
    vi.spyOn(permissive, 'limited').mockReturnValue(false);
    vi.spyOn(permissive, 'canEditField').mockReturnValue(true);
    vi.spyOn(permissive, 'restrictedForAnyone').mockReturnValue(false);
    vi.spyOn(permissive, 'readsEverything').mockReturnValue(true);
    vi.spyOn(permissive, 'schemaAccess').mockReturnValue(undefined);
    vi.spyOn(permissive, 'accessKey').mockReturnValue('all');
    const limited = everyone().filter((person) => !person.seesSalary || !person.seesAllRecords);
    const quiet: string[] = [];
    for (const path of PATHS) {
      if (path.control === false) continue;
      let leaked = false;
      for (const person of limited) {
        if (leaks(await path.read(person), forbiddenFor(f, person)).length) leaked = true;
      }
      if (!leaked) quiet.push(path.name);
    }
    expect(quiet).toEqual([]);
  });
});
