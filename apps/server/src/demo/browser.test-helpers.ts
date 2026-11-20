import { startTestPostgres } from '@riosoma/testkit';
import { DatabaseRole, newId, type CommandBatchResult } from '@riosoma/contracts';
import { resolve } from 'node:path';
import { startServer } from '../test/fixture.js';
import { readFixture } from '../data/snapshots.test-helpers.js';
import { insertRecords } from '../data/physical/records.js';
import { demoMedia } from '../data/files/demo.test-helpers.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { apply } from '../automations/automations.test-helpers.js';
import { request as httpRequest } from 'node:http';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import { once } from 'node:events';
import type { TLSSocket } from 'node:tls';
import { selfSignedCertificate } from '../test/saml-idp.js';

/** An isolated public instance lets browser tests start without any authentication cookie. */
const kit = await startTestPostgres();
const authorityToken = randomBytes(32).toString('hex');
let siteIngress: TlsServer | undefined = undefined;
const server = await startServer(kit, 'browserdemo', {
  webDir: process.env.RIOSOMA_E2E_WEB_DIR,
  themesDir: process.env.RIOSOMA_THEMES_DIR ?? resolve(import.meta.dirname, '../../../../themes'),
  demoLink: 'https://riosoma.com',
  tlsAskToken: authorityToken,
  tlsAskAddresses: '127.0.0.1',
});
const close = async () => {
  if (siteIngress) {
    siteIngress.closeAllConnections();
    await new Promise<void>((done) => siteIngress!.close(() => done()));
  }
  await server.close();
  await kit.stop();
  process.exit(0);
};
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
const role = DatabaseRole.parse(process.env.RIOSOMA_E2E_DEMO_ROLE ?? 'editor');
const member = await server.addMember();
const another = await readFixture(server, [{ type: 'text' }]);
const read = await readFixture(server, [
  { type: 'text' },
  { type: 'location' },
  { type: 'attachment' },
  { type: 'attachment' },
  { type: 'attachment' },
  { type: 'attachment' },
]);
const databaseId = read.table.databaseId;
const tableId = read.table.id;
const viewId = read.view.id;
const recordId = newId('record');
const dashboardId = newId('dashboard');
const mapViewId = newId('view');
const joinedTableId = newId('table');
const joinedViewId = newId('view');
const joinedFieldId = newId('field');
const keysTableId = newId('table');
const keysFieldId = newId('field');
const interfaceId = newId('interface');
const pageId = 'demoPage';
const otherDatabaseId = another.table.databaseId;
const media = await demoMedia(
  server,
  tableId,
  read.fields.slice(2).map((field) => field.id),
);
const linkFieldId = newId('field');
const linkedRecordId = newId('record');
await insertRecords(
  server.pool,
  server.schemas.data,
  another.table.id,
  another.fields,
  [{ id: linkedRecordId, values: { [another.fields[0]!.id]: 'Related record' } }],
  server.owner.userId,
);
await server.pool.query(`UPDATE "${server.schemas.app}".databases SET name = $1 WHERE id = $2`, [
  'More records',
  otherDatabaseId,
]);
await insertRecords(
  server.pool,
  server.schemas.data,
  tableId,
  read.fields,
  [
    {
      id: recordId,
      values: {
        [read.fields[0]!.id]: 'Sample record',
        [read.fields[1]!.id]: { lat: 47.6, lng: -122.3, label: 'Sample place' },
        [read.fields[2]!.id]: [media.s3.id],
        [read.fields[3]!.id]: [media.azure.id],
        [read.fields[4]!.id]: [media.local.id],
        [read.fields[5]!.id]: [media.pdf.id],
      },
    },
  ],
  server.owner.userId,
);
const dashboard = await server.app.inject({
  method: 'POST',
  url: `/api/databases/${databaseId}/commands`,
  headers: server.owner.headers,
  payload: {
    clientId: newId('client'),
    commands: [
      {
        kind: 'field.create',
        id: newId('command'),
        groupId: newId('action'),
        tableId,
        field: {
          id: linkFieldId,
          tableId,
          name: 'Related records',
          type: 'link',
          options: { linkedTableId: another.table.id, oneWay: true },
        },
      },
      {
        kind: 'record.update',
        id: newId('command'),
        groupId: newId('action'),
        tableId,
        records: [{ id: recordId, values: { [linkFieldId]: [linkedRecordId] } }],
      },
      {
        kind: 'table.create',
        id: newId('command'),
        groupId: newId('action'),
        table: {
          id: keysTableId,
          name: 'Keys',
          fields: [{ id: keysFieldId, name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
      {
        kind: 'table.create',
        id: newId('command'),
        groupId: newId('action'),
        table: {
          id: joinedTableId,
          name: 'Joined records',
          fields: [{ id: joinedFieldId, name: 'Name', type: 'text' }],
          view: { id: joinedViewId, name: 'Grid' },
          joined: {
            baseTableId: tableId,
            steps: [
              {
                tableId: keysTableId,
                leftTableId: tableId,
                leftFieldId: read.fields[0]!.id,
                rightFieldId: keysFieldId,
                kind: 'left',
              },
            ],
            fields: [{ tableId, fieldId: read.fields[0]!.id, outputFieldId: joinedFieldId }],
          },
        },
      },
      {
        kind: 'interface.create',
        id: newId('command'),
        groupId: newId('action'),
        interface: {
          id: interfaceId,
          name: 'Record desk',
          pages: [
            {
              id: pageId,
              name: 'Records',
              blocks: [
                {
                  id: 'demoRecords',
                  kind: 'records',
                  title: 'Sample records',
                  place: { x: 0, y: 0, w: 12, h: 5 },
                  source: { tableId, viewId, filter: null },
                  fieldIds: [read.fields[0]!.id],
                  display: 'list',
                },
                ...[2, 3, 4].map((index) => ({
                  id: `demoMedia${index}`,
                  kind: 'records',
                  title: ['Cloud image', 'Other cloud image', 'Local image'][index - 2],
                  place: { x: (index - 2) * 4, y: 5, w: 4, h: 3 },
                  source: { tableId, viewId, filter: null },
                  fieldIds: [read.fields[0]!.id],
                  display: 'cards',
                  coverFieldId: read.fields[index]!.id,
                })),
              ],
            },
          ],
        },
      },
      {
        kind: 'view.create',
        id: newId('command'),
        groupId: newId('action'),
        view: {
          id: mapViewId,
          tableId,
          name: 'Places',
          type: 'map',
          config: { map: { locationFieldId: read.fields[1]!.id } },
        },
      },
      {
        kind: 'dashboard.create',
        id: newId('command'),
        groupId: newId('action'),
        dashboard: {
          id: dashboardId,
          name: 'Overview',
          config: {
            tiles: [
              {
                id: 'demoCount',
                kind: 'number',
                title: 'Record count',
                place: { x: 0, y: 0, w: 3, h: 2 },
                source: { tableId, viewId, filter: null },
                value: { fn: 'count', fieldId: null },
              },
            ],
          },
        },
      },
    ],
  },
});
if (dashboard.statusCode !== 200) throw new Error('Demo database could not be seeded');
if (dashboard.json<CommandBatchResult>().results.some((result) => result.status !== 'applied'))
  throw new Error(`Demo commands could not be applied: ${dashboard.body}`);
await server.pool.query(
  `INSERT INTO "${server.schemas.app}".grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
   VALUES ($1, 'database', $2, 'user', $3, $5), ($1, 'database', $4, 'user', $3, $5)`,
  [member.info.org.id, databaseId, member.userId, otherDatabaseId, role],
);
// Site answers live in a separate database, so submitting never adds access to the demo tour.
const site = await readFixture(server, [{ type: 'text' }]);
const siteFormId = newId('view');
const siteInterfaceId = newId('interface');
const siteDomainId = randomUUID();
const siteHost = `${randomUUID()}.localhost`;
await apply(server, site.table.databaseId, [
  {
    kind: 'view.create',
    tableId: site.table.id,
    view: {
      id: siteFormId,
      tableId: site.table.id,
      name: 'Contact',
      type: 'form',
      config: { form: { questions: [{ fieldId: site.fields[0]!.id, label: 'Your name', required: true }] } },
    },
  },
  {
    kind: 'interface.create',
    interface: {
      id: siteInterfaceId,
      name: 'Contact site',
      pages: [
        {
          id: 'contactPage',
          name: 'Contact',
          blocks: [
            {
              id: 'contactForm',
              kind: 'button',
              label: 'Contact us',
              place: { x: 0, y: 0, w: 6, h: 2 },
              action: { kind: 'form', tableId: site.table.id, viewId: siteFormId },
            },
          ],
        },
      ],
    },
  },
]);
const published = await server.app.inject({
  method: 'PUT',
  url: `/api/interfaces/${siteInterfaceId}/site`,
  headers: server.owner.headers,
  payload: {
    slug: 'demo-contact',
    title: 'Contact site',
    theme: { id: 'palette', scheme: 'house' },
    pages: [{ pageId: 'contactPage', slug: 'contact', title: 'Contact' }],
  },
});
if (published.statusCode !== 200) throw new Error(`Contact site could not be published: ${published.body}`);
await server.pool.query(
  `INSERT INTO "${server.schemas.app}".custom_domains
   (id, org_id, host, challenge, kinds, verified_at, first_verified_at, checked_at)
   VALUES ($1, $2, $3, $4, ARRAY['sites'], now(), now(), now())`,
  [siteDomainId, server.owner.info.org.id, siteHost, randomUUID()],
);
await server.pool.query(
  `UPDATE "${server.schemas.app}".published_sites SET domain_id = $1 WHERE interface_id = $2`,
  [siteDomainId, siteInterfaceId],
);
server.config.demoAccount = member.email;
server.config.demoMode = true;
const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
const certificate = selfSignedCertificate(siteHost);
// The TLS ingress overwrites visitor assertions with its socket's authority and private credential.
siteIngress = createTlsServer(
  { key: certificate.privateKey, cert: certificate.certificate },
  (incoming, reply) => {
    const upstream = httpRequest(
      new URL(incoming.url!, address),
      {
        method: incoming.method,
        headers: {
          ...incoming.headers,
          'x-riosoma-public-authority': (incoming.socket as TLSSocket).servername || '',
          'x-riosoma-authority-token': authorityToken,
        },
      },
      (response) => {
        reply.writeHead(response.statusCode!, response.headers);
        response.pipe(reply);
      },
    );
    upstream.once('error', () => {
      reply.writeHead(502).end();
    });
    incoming.pipe(upstream);
  },
);
siteIngress.listen(0, '127.0.0.1');
await once(siteIngress, 'listening');
const siteAddress = new URL(address);
siteAddress.hostname = siteHost;
siteAddress.protocol = 'https:';
siteAddress.port = String((siteIngress.address() as { port: number }).port);
process.stdout.write(
  JSON.stringify({
    address,
    role,
    databaseId,
    otherDatabaseId,
    tableId,
    viewId,
    recordId,
    dashboardId,
    mapViewId,
    joinedTableId,
    joinedViewId,
    interfaceId,
    pageId,
    siteAddress: siteAddress.origin,
    siteDatabaseId: site.table.databaseId,
  }) + '\n',
);
