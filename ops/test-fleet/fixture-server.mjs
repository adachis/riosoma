import { createServer } from 'node:http';

export const FIXTURE_ROWS = [
  { id: 1, name: 'Alpha', amount: 12.5, active: true, day: '2026-01-15' },
  { id: 2, name: 'Zoë', amount: 25.0, active: false, day: '2026-01-16' },
  { id: 3, name: 'Charlie', amount: 7.75, active: true, day: '2026-01-17' },
  { id: 4, name: 'Delta', amount: 40.25, active: false, day: '2026-01-18' },
  { id: 5, name: 'Echo', amount: 19.99, active: true, day: '2026-01-19' },
  { id: 6, name: 'Foxtrot', amount: 3.5, active: false, day: '2026-01-20' },
];

const SERVER_HEADER = 'Riosoma-Test-Fleet/1.0';

function csvBody() {
  const header = 'id,name,amount,active,day';
  const lines = FIXTURE_ROWS.map(
    (row) => `${row.id},${row.name},${row.amount.toFixed(2)},${row.active},${row.day}`,
  );
  return `${[header, ...lines].join('\n')}\n`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function atomFeedBody(baseUrl) {
  const entries = FIXTURE_ROWS.map((row) => {
    const updated = `${row.day}T00:00:00Z`;
    const link = `${baseUrl}/feed/items/${row.id}`;
    return [
      '  <entry>',
      `    <id>${row.id}</id>`,
      `    <title>${escapeXml(row.name)}</title>`,
      `    <link href="${escapeXml(link)}"/>`,
      `    <author><name>Fleet Seed</name></author>`,
      `    <published>${updated}</published>`,
      `    <updated>${updated}</updated>`,
      `    <summary>${escapeXml(`amount=${row.amount.toFixed(2)} active=${row.active} day=${row.day}`)}</summary>`,
      `    <content type="html">${escapeXml(`<p>${row.name}: ${row.amount.toFixed(2)}</p>`)}</content>`,
      `    <category term="${row.active ? 'active' : 'inactive'}"/>`,
      '  </entry>',
    ].join('\n');
  }).join('\n');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <id>urn:riosoma:test-fleet:feed</id>',
    '  <title>Riosoma Test Fleet Feed</title>',
    '  <updated>2026-01-20T00:00:00Z</updated>',
    entries,
    '</feed>',
    '',
  ].join('\n');
}

const ODATA_METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Fleet" Alias="F">
      <EntityType Name="Item">
        <Key>
          <PropertyRef Name="id"/>
        </Key>
        <Property Name="id" Type="Edm.Int32" Nullable="false"/>
        <Property Name="name" Type="Edm.String"/>
        <Property Name="amount" Type="Edm.Double"/>
        <Property Name="active" Type="Edm.Boolean"/>
        <Property Name="day" Type="Edm.Date"/>
      </EntityType>
      <EntityContainer Name="Default">
        <EntitySet Name="Items" EntityType="F.Item"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

function applyODataFilter(rows, filter) {
  if (!filter) return rows;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+eq\s+(.+)$/i.exec(filter.trim());
  if (!match) return rows;
  const [, column, raw] = match;
  let target;
  if (raw.startsWith("'") && raw.endsWith("'")) target = raw.slice(1, -1).replaceAll("''", "'");
  else if (raw === 'true') target = true;
  else if (raw === 'false') target = false;
  else if (raw === 'null') target = null;
  else target = Number(raw);
  return rows.filter((row) => row[column] === target);
}

function applyODataOrder(rows, orderby) {
  if (!orderby) return rows;
  const parts = orderby.trim().split(/\s+/);
  const column = parts[0];
  const direction = (parts[1] ?? 'asc').toLowerCase() === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * direction);
}

function handleGraphQl(body) {
  const parsed = JSON.parse(body || '{}');
  const query = String(parsed.query ?? '');
  if (query.includes('__schema')) {
    return {
      data: {
        __schema: {
          types: [
            {
              name: 'Item',
              fields: [
                { name: 'id', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Int' } } },
                { name: 'name', type: { kind: 'SCALAR', name: 'String' } },
                { name: 'amount', type: { kind: 'SCALAR', name: 'Float' } },
                { name: 'active', type: { kind: 'SCALAR', name: 'Boolean' } },
                { name: 'day', type: { kind: 'SCALAR', name: 'String' } },
              ],
            },
          ],
        },
      },
    };
  }
  const after = parsed.variables?.after ?? null;
  const pageSize = 3;
  const start = after === 'cursor-3' ? 3 : 0;
  const nodes = FIXTURE_ROWS.slice(start, start + pageSize);
  const hasNextPage = start + pageSize < FIXTURE_ROWS.length;
  return {
    data: {
      items: {
        nodes,
        pageInfo: {
          hasNextPage,
          endCursor: hasNextPage ? `cursor-${start + pageSize}` : null,
        },
      },
    },
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export async function startFixtureServer(port = 0, host = '127.0.0.1') {
  const server = createServer(async (request, response) => {
    const address = server.address();
    const baseUrl = `http://${address.address}:${address.port}`;
    const url = new URL(request.url ?? '/', baseUrl);
    response.setHeader('server', SERVER_HEADER);

    if (url.pathname === '/file/items.csv') {
      const body = csvBody();
      response.setHeader('content-type', 'text/csv; charset=utf-8');
      response.setHeader('content-length', String(Buffer.byteLength(body)));
      if (request.method === 'HEAD') {
        response.writeHead(200);
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(body);
      return;
    }

    if (url.pathname === '/rest/items') {
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
      const limit = Math.max(1, Number(url.searchParams.get('limit') ?? 3));
      const items = FIXTURE_ROWS.slice(offset, offset + limit);
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.writeHead(200);
      response.end(JSON.stringify({ items, total: FIXTURE_ROWS.length }));
      return;
    }

    if (url.pathname === '/graphql' && request.method === 'POST') {
      const raw = await readRequestBody(request);
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.writeHead(200);
      response.end(JSON.stringify(handleGraphQl(raw)));
      return;
    }

    if (url.pathname === '/odata/$metadata') {
      response.setHeader('odata-version', '4.0');
      response.setHeader('content-type', 'application/xml; charset=utf-8');
      response.writeHead(200);
      response.end(ODATA_METADATA);
      return;
    }

    if (url.pathname === '/odata/Items') {
      response.setHeader('odata-version', '4.0');
      response.setHeader('content-type', 'application/json; charset=utf-8');
      const filter = url.searchParams.get('$filter');
      const orderby = url.searchParams.get('$orderby');
      const top = url.searchParams.has('$top') ? Number(url.searchParams.get('$top')) : null;
      const skip = Number(url.searchParams.get('$skiptoken') ?? 0);
      let rows = applyODataFilter(FIXTURE_ROWS, filter);
      rows = applyODataOrder(rows, orderby);
      if (filter || orderby || top !== null) {
        const sliced = top !== null ? rows.slice(0, top) : rows;
        response.writeHead(200);
        response.end(JSON.stringify({ value: sliced }));
        return;
      }
      const pageSize = 3;
      const sliced = rows.slice(skip, skip + pageSize);
      const next = skip + pageSize < rows.length ? `Items?$skiptoken=${skip + pageSize}` : undefined;
      response.writeHead(200);
      response.end(JSON.stringify({ value: sliced, ...(next ? { '@odata.nextLink': next } : {}) }));
      return;
    }

    if (url.pathname === '/feed/items.xml') {
      const body = atomFeedBody(baseUrl);
      response.setHeader('content-type', 'application/atom+xml; charset=utf-8');
      response.setHeader('content-length', String(Buffer.byteLength(body)));
      response.writeHead(200);
      response.end(body);
      return;
    }

    response.writeHead(404);
    response.end('Not Found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;
  return {
    baseUrl,
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.RIOSOMA_FIXTURE_PORT ?? process.argv[2] ?? 18900);
  const server = await startFixtureServer(port);
  process.stdout.write(`${server.baseUrl}\n`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
