import { RemoteSchemaValidator } from './schema.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AppError, RemoteServerConfig } from '@riosoma/contracts';
import { RemoteClients, remoteName } from './client.js';
import { guardedFetch } from './fetch.js';
import { standIn } from './stand-in.test-support.js';

const policy = { production: false, automationsAllowPrivateHosts: false };
let server: Awaited<ReturnType<typeof standIn>>;
beforeEach(async () => {
  server = await standIn();
});
afterEach(async () => {
  await server.close();
});
const config = (address: string, allowPrivate = true) =>
  RemoteServerConfig.parse({
    name: 'Outside',
    address,
    allowPrivate,
    auth: 'none',
    audience: { everyone: true },
  });

it('discovers read-only and write tools through Streamable HTTP and SSE', async () => {
  const client = new RemoteClients(15000, 30000, policy);
  for (const address of [server.address, `${server.origin}/legacy`]) {
    const tools = await client.discover(address, config(address));
    expect(tools.map((tool) => [tool.name, tool.readOnly])).toEqual([
      ['inspect', true],
      ['write', false],
    ]);
  }
  expect(remoteName('a', 'Outside', 'inspect')).not.toBe(remoteName('b', 'Outside', 'inspect'));
});
it('blocks private addresses before credentials leave the process', async () => {
  await expect(
    new RemoteClients(15000, 30000, policy).discover('blocked', config(server.address, false)),
  ).rejects.toMatchObject({
    messageKey: 'remote.blockedAddress',
  });
  expect(server.state.connections).toBe(0);
  await expect(
    guardedFetch(false, AbortSignal.timeout(1000), async () => [
      { address: [10, 0, 0, 1].join('.'), family: 4 },
    ])(`${server.origin.replace(/[0-9.]+(?=:)/, `${crypto.randomUUID()}.${'invalid'}`)}/mcp`),
  ).rejects.toMatchObject({ messageKey: 'remote.blockedAddress' });
});
it('opens the server circuit after three failures and recovers after the cooldown', async () => {
  server.state.failing = true;
  const client = new RemoteClients(1000, 30, policy);
  for (let at = 0; at < 3; at++)
    await expect(client.discover('down', config(server.address))).rejects.toMatchObject({
      messageKey: 'remote.unavailable',
    });
  const count = server.state.connections;
  await expect(client.discover('down', config(server.address))).rejects.toMatchObject({
    messageKey: 'remote.unavailable',
  });
  expect(server.state.connections).toBe(count);
  await new Promise((resolve) => setTimeout(resolve, 40));
  server.state.failing = false;
  expect(await client.discover('down', config(server.address))).toHaveLength(2);
});
it('ends a request when the server stops responding', async () => {
  server.state.hanging = true;
  await expect(
    new RemoteClients(50, 30000, policy).discover('timeout', config(server.address)),
  ).rejects.toMatchObject({
    messageKey: 'remote.unavailable',
  });
});

it('identifies rejected API keys without treating them as server outages', async () => {
  const validKey = crypto.randomUUID();
  server.state.header = { name: 'x-api-key', value: validKey };
  const secure = await standIn(true);
  try {
    secure.state.header = server.state.header;
    const settings = { ...config(secure.address), auth: 'header' as const, header: 'x-api-key' };
    const client = new RemoteClients(15000, 30000, policy);
    for (let attempt = 0; attempt < 4; attempt++)
      await expect(client.discover('key', settings, crypto.randomUUID())).rejects.toMatchObject({
        messageKey: 'remote.credentialRejected',
      });
    expect(await client.discover('key', settings, validKey)).toHaveLength(2);
  } finally {
    await secure.close();
  }
});

it.each([401, 403] as const)(
  'identifies rejected API keys after the SSE fallback returns %s',
  async (status) => {
    const secure = await standIn(true);
    const validKey = crypto.randomUUID();
    try {
      secure.state.header = { name: 'x-api-key', value: validKey };
      secure.state.headerStatus = status;
      const settings = {
        ...config(`${secure.origin}/legacy`),
        auth: 'header' as const,
        header: 'x-api-key',
      };
      const client = new RemoteClients(15000, 30000, policy);
      for (let attempt = 0; attempt < 4; attempt++) {
        await expect(client.discover('legacy-key', settings, crypto.randomUUID())).rejects.toMatchObject({
          code: 'forbidden',
          messageKey: 'remote.credentialRejected',
        });
        expect(secure.state.connections).toBe((attempt + 1) * 2);
      }
      expect(await client.discover('legacy-key', settings, validKey)).toHaveLength(2);
    } finally {
      await secure.close();
    }
  },
);

it('refuses executable remote schema patterns before compilation', () => {
  expect(() => new RemoteSchemaValidator().getValidator({ type: 'string', pattern: '^(a+)+$' })).toThrow(
    'remote.schemaBlocked',
  );
});

it('accepts keyword-shaped property names, formats, and bounded local definitions', () => {
  const validate = new RemoteSchemaValidator().getValidator({
    type: 'object',
    $defs: { text: { type: 'string', format: 'email' } },
    properties: { pattern: { $ref: '#/$defs/text' }, format: { type: 'string' }, $ref: { type: 'string' } },
  });
  expect(validate({ pattern: 'plain text', format: 'x', $ref: 'y' }).valid).toBe(true);
  expect(validate({ pattern: 1 }).valid).toBe(false);
});
it('rejects recursive and external references within the schema budget', () => {
  for (const schema of [
    { $defs: { loop: { $ref: '#/$defs/loop' } }, $ref: '#/$defs/loop' },
    { $ref: `https://${crypto.randomUUID()}.invalid/schema` },
  ])
    expect(() => new RemoteSchemaValidator().getValidator(schema)).toThrow();
});
it('does not open the circuit for caller refusals or protocol errors', async () => {
  const client = new RemoteClients(15000, 30000, policy);
  for (let at = 0; at < 3; at++)
    await expect(
      client.withClient('caller', config(server.address), undefined, undefined, async () => {
        throw new AppError('conflict', 'errors.conflict');
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  expect(await client.discover('caller', config(server.address))).toHaveLength(2);
});
it('honors an already aborted caller signal without contacting the server', async () => {
  const signal = AbortSignal.abort();
  await expect(
    new RemoteClients(15000, 30000, policy).withClient(
      'stop',
      config(server.address),
      undefined,
      undefined,
      async (client) => client.listTools(),
      signal,
    ),
  ).rejects.toThrow();
  expect(server.state.connections).toBe(0);
});
it('refuses cleartext credential requests before opening a connection', async () => {
  await expect(
    guardedFetch(true, AbortSignal.timeout(1000))(server.address, {
      headers: { authorization: `Bearer ${crypto.randomUUID()}` },
    }),
  ).rejects.toMatchObject({ messageKey: 'remote.blockedAddress' });
  expect(server.state.connections).toBe(0);
});
it('keeps supported tools when another schema is unsupported and truncates discovery', async () => {
  server.state.extraTools = [
    { name: 'unsupported', inputSchema: { type: 'object', properties: { x: { pattern: 'x' } } } },
    ...Array.from({ length: 110 }, (_, i) => ({
      name: `extra${i}`,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', patternProperties: { x: { type: 'string' } } },
    })),
  ];
  const tools = await new RemoteClients(15000, 30000, policy).discover('many', config(server.address));
  expect(tools).toHaveLength(100);
  expect(tools.some((tool) => tool.name === 'unsupported')).toBe(false);
  expect(tools[0]?.name).toBe('inspect');
});
