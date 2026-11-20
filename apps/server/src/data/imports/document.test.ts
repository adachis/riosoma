import { deflateSync } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import {
  ProviderError,
  registerProvider,
  REGISTRY,
  RetryableProviderError,
  type RegistryModel,
  type ChatRequest,
} from '@riosoma/ai';
import {
  ClassificationRules,
  DocumentImportSettings,
  DocumentImportResult,
  KnowledgeSettings,
  newId,
  type DocumentImportRequest,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { spent } from '../../ai/settings.js';
import { actorFor } from '../../automations/run.js';
import { MCP_LIMITS, TOOLS, callTool } from '../../mcp/tools.js';
import { RecordReader } from '../../api-v1/reads.js';
import type { FastifyRequest } from 'fastify';
import { documentMessage, extractDocument } from './document.js';
import { DOCUMENT_TIMING } from './document-queue.js';
import { eicar, standIn, unreachableScanner } from '../files/scan-test-support.js';

let kit: TestPostgres;
let server: ServerFixture;
let image: Buffer;
let requests: ChatRequest[] = [];
let output: unknown;
let delay = 0;
let failure: 'refused' | 'unreachable' | 'interrupted' | undefined;
let reportUsage = true;
let stop: 'end' | 'length' = 'end';
const timing = { ...DOCUMENT_TIMING };
const draft = {
  columns: [
    { name: 'Item', type: 'text' },
    { name: 'Quantity', type: 'number' },
  ],
  rows: [
    [
      { value: 'Pencils', confidence: 0.95 },
      { value: '12', confidence: 0.4 },
    ],
  ],
};
const model = { providerId: 'document-fixture', model: 'document-reader' };
const local = { providerId: 'document-local-fixture', model: 'local-reader' };
const registry: RegistryModel = {
  ...model,
  name: 'Document fixture',
  tiers: ['vision'],
  price: { input: 1, output: 2 },
  contextTokens: 200_000,
  maxOutputTokens: 65_536,
  tools: false,
};

beforeAll(async () => {
  (REGISTRY as RegistryModel[]).push(registry);
  for (const ref of [model, local])
    registerProvider({
      id: ref.providerId,
      name: 'Document fixture',
      local: ref === local,
      async listModels() {
        return [{ model: ref.model, name: 'Document reader' }];
      },
      async *stream(_config, request) {
        requests.push(request);
        if (delay) await pause(delay, request.signal);
        if (failure === 'refused') throw new ProviderError('ai.provider.rateLimited', 429, 'Slow down');
        if (failure === 'unreachable')
          throw new RetryableProviderError('ai.provider.unavailable', undefined, 'Connection refused');
        const text = JSON.stringify(output);
        if (failure === 'interrupted') {
          yield { type: 'text', delta: text.slice(0, 10) };
          throw new Error('Interrupted fixture');
        }
        yield { type: 'text', delta: text };
        if (reportUsage) yield { type: 'usage', inputTokens: 100, outputTokens: 40 };
        yield { type: 'done', stop };
      },
    });
  image = await sharp({
    create: { width: 24, height: 24, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .png()
    .toBuffer();
  kit = await startTestPostgres();
  server = await startServer(kit, 'document_import');
  server.config.providerApiKeys = { [model.providerId]: randomBytes(24).toString('hex') };
}, 60_000);
afterAll(async () => {
  (REGISTRY as RegistryModel[]).splice(REGISTRY.indexOf(registry), 1);
  await server?.close();
  await kit?.stop();
});

/** A stand-in provider's wait that ends early when the call is stopped, as a real request does. */
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
async function usageTotals() {
  const row = (
    await query<{ calls: string; input: string; estimated: string }>(
      server.pool,
      sql`SELECT coalesce(sum(calls), 0)::text AS calls, coalesce(sum(input_tokens), 0)::text AS input,
        coalesce(sum(token_estimated_calls), 0)::text AS estimated
      FROM ${ident(server.schemas.app, 'ai_usage')}`,
    )
  ).rows[0]!;
  return {
    calls: Number(row.calls),
    input: Number(row.input),
    estimated: Number(row.estimated),
    cost: await spent(server.ctx, server.owner.info.org.id),
  };
}
async function governance(action: unknown) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/admin/governance/commands',
    headers: server.owner.headers,
    payload: { kind: 'governance.apply', id: newId('command'), action },
  });
  expect(response.json().status, response.body).toBe('applied');
}
const LABELS = [
  {
    id: 'private-import',
    name: 'Private import',
    color: 'red',
    description: '',
    rules: ClassificationRules.parse({ noProviders: true }),
  },
  {
    id: 'open-import',
    name: 'Open import',
    color: 'green',
    description: '',
    rules: ClassificationRules.parse({}),
  },
];
function send(payload: DocumentImportRequest, headers = server.owner.headers) {
  return server.app.inject({ method: 'POST', url: '/api/imports/document', headers, payload });
}
function input(patch: Partial<DocumentImportRequest> = {}): DocumentImportRequest {
  return {
    data: image.toString('base64'),
    mediaType: 'image/png',
    label: 'internal',
    locale: 'en-US',
    ...patch,
  };
}
async function configure(patch: Partial<DocumentImportSettings> = {}) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/knowledge/commands',
    headers: server.owner.headers,
    payload: {
      kind: 'knowledge.settings',
      id: randomUUID(),
      settings: KnowledgeSettings.parse({ imports: { model, ...patch } }),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().status).not.toBe('rejected');
  return response.json() as { actionId: string };
}

it('refuses the antivirus test string and scanner outages before document parsing or provider calls', async () => {
  const scanner = await standIn();
  const set = (enabled: boolean, address: string) =>
    query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')}
    SET settings = jsonb_set(settings, '{fileScanner}', ${JSON.stringify({ enabled, address, oversizedPolicy: 'quarantine' })}::jsonb)
    WHERE id = ${server.owner.info.org.id}`,
    );
  server.config.clamavApprovedUrls = [scanner.url];
  try {
    await configure();
    await set(true, scanner.url);
    const infected = input({ mediaType: 'text/csv', data: eicar.toString('base64') });
    const refused = await send(infected);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().error.messageKey).toBe('files.checks.infected');
    expect(requests).toHaveLength(0);
    expect(scanner.received.at(-1)).toEqual(eicar);
    const missing = await unreachableScanner();
    server.config.clamavApprovedUrls.push(missing);
    await set(true, missing);
    const outage = await send(input());
    expect(outage.statusCode, outage.body).toBe(503);
    expect(outage.json().error.messageKey).toBe('files.checks.scannerUnavailable');
    expect(requests).toHaveLength(0);
    await set(false, missing);
    const allowed = await send(infected);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(requests).toHaveLength(1);
  } finally {
    await set(false, scanner.url);
    delete server.config.clamavApprovedUrls;
    await scanner.close();
  }
});
beforeEach(async () => {
  requests = [];
  output = structuredClone(draft);
  stop = 'end';
  delay = 0;
  failure = undefined;
  reportUsage = true;
  Object.assign(DOCUMENT_TIMING, timing);
  const response = await server.app.inject({
    method: 'PUT',
    url: '/api/ai/settings',
    headers: server.owner.headers,
    payload: {
      enabled: true,
      providers: [{ providerId: model.providerId }, { providerId: local.providerId }],
      models: { everyday: model, power: null },
      monthlyBudgetUsd: null,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  await configure();
});

it('returns uncertain readings without creating records and counts the call', async () => {
  const before = await server.app.inject({ url: '/api/ai/footprint/mine', headers: server.owner.headers });
  const response = await send(input());
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject(draft);
  expect(DocumentImportResult.safeParse(response.json()).success).toBe(true);
  expect(requests[0]!.messages[1]).toMatchObject({ role: 'user', attachments: [{ mediaType: 'image/png' }] });
  const after = await server.app.inject({ url: '/api/ai/footprint/mine', headers: server.owner.headers });
  expect(after.json().calls).toBe(before.json().calls + 1);
  const databases = await server.app.inject({ url: '/api/databases', headers: server.owner.headers });
  expect(databases.json()).toEqual([]);
});

it('blocks confidential and restricted uploads before the hosted provider sees them', async () => {
  for (const label of ['confidential', 'restricted'] as const)
    expect((await send(input({ label }))).statusCode).toBe(403);
  expect(requests).toHaveLength(0);
});

it('keeps local processing local and records configured power', async () => {
  await configure({ localModel: local, powerWatts: 120 });
  const response = await send(input({ label: 'confidential' }));
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().usage).toMatchObject({
    providerId: local.providerId,
    footprint: { method: 'service-power-v1' },
  });
  expect(requests).toHaveLength(1);
  const pdf = await PDFDocument.create();
  pdf.addPage();
  expect(
    (
      await send(
        input({ mediaType: 'application/pdf', data: Buffer.from(await pdf.save()).toString('base64') }),
      )
    ).json().error.messageKey,
  ).toBe('import.document.localPdf');
  expect(requests).toHaveLength(1);
});

it('refuses malformed bytes and enforced size and PDF page limits before invocation', async () => {
  expect((await send(input({ data: randomBytes(24).toString('base64') }))).statusCode).toBe(422);
  expect((await send(input({ data: image.toString('base64') + '!' }))).statusCode).toBe(422);
  await configure({ uploadBytes: 1024, pages: 1 });
  expect((await send(input({ data: randomBytes(1025).toString('base64') }))).statusCode).toBe(413);
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  const response = await send(
    input({ mediaType: 'application/pdf', data: Buffer.from(await pdf.save()).toString('base64') }),
  );
  expect(response.statusCode, response.body).toBe(413);
  expect(requests).toHaveLength(0);
});

it('reads PDFs and messy workbooks through the same bounded preview', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const response = await send(
    input({ mediaType: 'application/pdf', data: Buffer.from(await pdf.save()).toString('base64') }),
  );
  expect(response.statusCode, response.body).toBe(200);
  expect(requests[0]!.messages[1]).toMatchObject({ attachments: [{ mediaType: 'application/pdf' }] });
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Inventory').addRows([
    ['Item', 'Quantity'],
    ['Pencils', 12],
  ]);
  const sheet = await send(
    input({
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64'),
    }),
  );
  expect(sheet.statusCode, sheet.body).toBe(200);
  expect(requests[1]!.messages[1]!.content).toContain('Pencils');
});

it('rejects incomplete or malformed model output while still counting the call', async () => {
  stop = 'length';
  expect((await send(input())).json().error.messageKey).toBe('import.document.tooLarge');
  stop = 'end';
  output = { ...draft, rows: [[{ value: 'Invented', confidence: 2 }]] };
  expect((await send(input())).statusCode).toBe(422);
  output = { tooLarge: true };
  expect((await send(input())).statusCode).toBe(413);
});

it('requires destination access, a current session, and an available budget', async () => {
  const member = await server.addMember();
  expect((await send(input({ databaseId: newId('database') }), member.headers)).statusCode).toBe(404);
  expect(
    (await server.app.inject({ method: 'POST', url: '/api/imports/document', payload: input() })).statusCode,
  ).toBe(401);
  await server.app.inject({
    method: 'PUT',
    url: '/api/ai/settings',
    headers: server.owner.headers,
    payload: { monthlyBudgetUsd: 0 },
  });
  expect((await send(input())).json().error.messageKey).toBe('rio.paused');
  expect(requests).toHaveLength(0);
});

it('saves import limits through an undoable settings command', async () => {
  const { actionId } = await configure({ pages: 2 });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/knowledge/commands',
    headers: server.owner.headers,
    payload: { kind: 'knowledge.undo', id: randomUUID(), actionId },
  });
  expect(response.statusCode, response.body).toBe(200);
  const settings = await server.app.inject({ url: '/api/knowledge/settings', headers: server.owner.headers });
  expect(settings.json().imports.pages).toBe(10);
});

it('exposes the same preview to write-scoped tokens and refuses read-only tokens', async () => {
  for (const scope of ['data.records:read', 'data.records:write']) {
    const token = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: server.owner.headers,
      payload: { name: 'Document reader', scopes: [scope], databases: 'all' },
    });
    expect(token.statusCode, token.body).toBe(200);
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/imports/document',
      headers: { authorization: `Bearer ${token.json().token}` },
      payload: input(),
    });
    expect(response.statusCode, response.body).toBe(scope === 'data.records:write' ? 200 : 403);
    if (scope === 'data.records:write') expect(response.json()).toMatchObject(draft);
  }
  expect(requests).toHaveLength(1);
});

it('rejects a mislabeled image and text containing binary bytes', async () => {
  const limits = DocumentImportSettings.parse({});
  await expect(
    documentMessage(input({ mediaType: 'image/jpeg' }), limits, AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ messageKey: 'import.document.invalid' });
  await expect(
    documentMessage(
      input({ mediaType: 'text/csv', data: Buffer.from([65, 0, 66]).toString('base64') }),
      limits,
      AbortSignal.timeout(1000),
    ),
  ).rejects.toMatchObject({ messageKey: 'import.document.invalid' });
});

it('keeps a rotated photo within its upload limit while removing private metadata', async () => {
  const photo = await sharp(randomBytes(256 * 512 * 3), {
    raw: { width: 256, height: 512, channels: 3 },
  })
    .jpeg({ quality: 80 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const limits = DocumentImportSettings.parse({ uploadBytes: photo.length + 4096 });
  const message = await documentMessage(
    input({ mediaType: 'image/jpeg', data: photo.toString('base64') }),
    limits,
    AbortSignal.timeout(1000),
  );
  expect(message.role).toBe('user');
  if (message.role !== 'user') throw new Error('Expected an uploaded document');
  const attachment = message.attachments![0]!;
  expect(attachment.mediaType).toBe('image/jpeg');
  const cleaned = Buffer.from(attachment.data, 'base64');
  expect(cleaned.length).toBeLessThanOrEqual(limits.uploadBytes);
  const metadata = await sharp(cleaned).metadata();
  expect(metadata).toMatchObject({ format: 'jpeg', width: 512, height: 256 });
  expect(metadata.orientation).toBeUndefined();
  expect(metadata.exif).toBeUndefined();
});

async function destination() {
  const databaseId = newId('database');
  const tableId = newId('table');
  const fieldId = newId('field');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Import destination',
      table: {
        id: tableId,
        name: 'Stock',
        fields: [{ id: fieldId, name: 'Stock name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { databaseId, tableId, fieldId };
}

it.each(['database', 'table', 'field'] as const)(
  'enforces %s provider classification before reading an upload',
  async (kind) => {
    const target = await destination();
    await governance({ kind: 'classification.labels', labels: LABELS });
    await governance({
      kind: 'classification.assign',
      target: {
        kind,
        databaseId: target.databaseId,
        ...(kind === 'table'
          ? { tableId: target.tableId }
          : kind === 'field'
            ? { fieldId: target.fieldId }
            : {}),
      },
      labelId: 'private-import',
    });
    const response = await send(
      input({
        label: 'public',
        databaseId: target.databaseId,
        ...(kind === 'database' ? {} : { tableId: target.tableId }),
      }),
    );
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.messageKey).toBe('governance.classificationDenied');
    expect(requests).toHaveLength(0);
  },
);

it('supplies the destination field names and types for matching', async () => {
  const target = await destination();
  expect((await send(input(target))).statusCode).toBe(200);
  expect(requests[0]!.messages[0]!.content).toContain('Stock name');
  expect(requests[0]!.messages[0]!.content).toContain('"type":"text"');
});

it('accepts compact rows and sparse confidence readings at the full cell limit', async () => {
  output = {
    columns: Array.from({ length: 50 }, (_, i) => ({ name: `Column ${i}`, type: 'text' })),
    rows: Array.from({ length: 500 }, () => Array.from({ length: 50 }, () => 'x')),
    uncertain: [[499, 49, 0.3]],
  };
  const response = await send(input());
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().rows[499][49]).toEqual({ value: 'x', confidence: 0.3 });
  expect(response.json().rows[0][0]).toEqual({ value: 'x', confidence: 1 });
  expect(requests[0]!.maxOutputTokens).toBeGreaterThan(16_000);
});

it('rejects oversized declared bodies before parsing JSON', async () => {
  await configure({ uploadBytes: 1024 });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/imports/document',
    headers: { ...server.owner.headers, 'content-type': 'application/json', 'content-length': '10000' },
    payload: '{',
  });
  expect(response.statusCode, response.body).toBe(413);
  expect(requests).toHaveLength(0);
});

it('estimates consumed input when a provider exits without usage', async () => {
  failure = 'interrupted';
  const tokens = async () =>
    Number(
      (
        await query(
          server.pool,
          sql`SELECT coalesce(sum(input_tokens), 0) AS total FROM ${ident(server.schemas.app, 'ai_usage')}`,
        )
      ).rows[0]!.total,
    );
  const before = await tokens();
  const beforeCost = await spent(server.ctx, server.owner.info.org.id);
  expect((await send(input())).statusCode).toBe(503);
  expect(await tokens()).toBeGreaterThan(before);
  expect(await spent(server.ctx, server.owner.info.org.id)).toBeGreaterThan(beforeCost);
});

it('allows document previews to finish beyond the ordinary tool deadline', async () => {
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  actor.token = { id: randomUUID(), scopes: ['data.records:write'], databases: null };
  const original = MCP_LIMITS.callMs;
  MCP_LIMITS.callMs = 10;
  delay = 80;
  try {
    const result = await callTool(
      {
        app: server.app,
        actor,
        request: { actor, log: server.app.log } as unknown as FastifyRequest,
        reader: new RecordReader(server.app),
      },
      'preview_document_import',
      input(),
    );
    expect(result.isError).not.toBe(true);
    expect(TOOLS.find((tool) => tool.definition.name === 'preview_document_import')).toBeDefined();
  } finally {
    MCP_LIMITS.callMs = original;
  }
});

it('queues one person without taking the other extraction slot', async () => {
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  delay = 100;
  const first = extractDocument(server.ctx, actor, input());
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const second = extractDocument(server.ctx, actor, input());
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    expect(requests).toHaveLength(1);
  } finally {
    await Promise.all([first, second]);
  }
  expect(requests).toHaveLength(2);
});

it('downscales large images and refuses extreme aspect ratios', async () => {
  const limits = DocumentImportSettings.parse({});
  const photo = await sharp({ create: { width: 4096, height: 2048, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  const result = await documentMessage(
    input({ data: photo.toString('base64') }),
    limits,
    AbortSignal.timeout(5000),
  );
  if (result.role !== 'user') throw new Error('Expected document');
  const metadata = await sharp(Buffer.from(result.attachments![0]!.data, 'base64')).metadata();
  expect(metadata.width).toBe(2048);
  expect(metadata.height).toBe(1024);
  const strip = await sharp({ create: { width: 1, height: 9000, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  await expect(
    documentMessage(input({ data: strip.toString('base64') }), limits, AbortSignal.timeout(5000)),
  ).rejects.toMatchObject({ messageKey: 'import.document.invalid' });
});

it.each([false, true])('bounds compressed object streams with chained filters %s', async (chained) => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const compressed = deflateSync(Buffer.alloc(5 * 1024 * 1024, 32));
  pdf.context.register(
    pdf.context.stream(chained ? deflateSync(compressed) : compressed, {
      Type: 'ObjStm',
      N: 0,
      First: 0,
      Filter: chained ? ['FlateDecode', 'FlateDecode'] : 'FlateDecode',
    }),
  );
  const response = await send(
    input({
      mediaType: 'application/pdf',
      data: Buffer.from(await pdf.save({ useObjectStreams: false })).toString('base64'),
    }),
  );
  expect(response.json().error.messageKey).toBe('import.document.invalid');
  expect(requests).toHaveLength(0);
});

it('bounds queued uploads before reading their bodies and releases canceled requests', async () => {
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  const member = await server.addMember();
  const other = (await actorFor(server.pool, server.schemas, member.userId, actor.orgId))!;
  delay = 250;
  const first = extractDocument(server.ctx, actor, input());
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const read = vi.fn(async () => input());
  const pending = controllers.map((controller) =>
    extractDocument(server.ctx, actor, read, controller.signal).catch((error: unknown) => error),
  );
  const excess = extractDocument(server.ctx, actor, read);
  const refused = expect(excess).rejects.toMatchObject({ messageKey: 'import.document.busy' });
  const second = extractDocument(server.ctx, other, input());
  try {
    await refused;
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(read).not.toHaveBeenCalled();
  } finally {
    controllers.forEach((controller) => controller.abort());
    await Promise.all([first, second, ...pending]);
  }
  for (const result of await Promise.all(pending))
    expect(result).toMatchObject({ messageKey: 'import.document.canceled', userFault: true });
  expect(read).not.toHaveBeenCalled();
  expect((await extractDocument(server.ctx, actor, input())).rows).toHaveLength(1);
});

it('records elapsed local power when an interrupted stream omits usage', async () => {
  await configure({ localModel: local, powerWatts: 100 });
  failure = 'interrupted';
  const before = (
    await server.app.inject({ url: '/api/ai/footprint/mine', headers: server.owner.headers })
  ).json();
  expect((await send(input())).statusCode).toBe(503);
  const after = (
    await server.app.inject({ url: '/api/ai/footprint/mine', headers: server.owner.headers })
  ).json();
  expect(after.energyWh.min).toBeGreaterThan(before.energyWh.min);
  expect(after.gwpG.min).toBeGreaterThan(before.gwpG.min);
});

it('caps encoded image bytes even when the upload setting permits larger files', async () => {
  const photo = await sharp(randomBytes(1500 * 1500 * 3), {
    raw: { width: 1500, height: 1500, channels: 3 },
  })
    .png()
    .toBuffer();
  const limits = DocumentImportSettings.parse({ uploadBytes: 10 * 1024 * 1024 });
  await expect(
    documentMessage(input({ data: photo.toString('base64') }), limits, AbortSignal.timeout(5000)),
  ).rejects.toMatchObject({ messageKey: 'import.document.tooLarge' });
});

it('charges nothing when the provider refuses the request or cannot be reached', async () => {
  for (const kind of ['refused', 'unreachable'] as const) {
    failure = kind;
    const before = await usageTotals();
    const response = await send(input());
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json().error.messageKey).toBe('import.document.failed');
    expect(await usageTotals()).toEqual(before);
  }
});

it('estimates interrupted input by kind of file and marks the estimate', async () => {
  failure = 'interrupted';
  // Noise compresses badly, so the file's bytes far outweigh what its pixels cost.
  const photo = await sharp(randomBytes(600 * 400 * 3), { raw: { width: 600, height: 400, channels: 3 } })
    .png()
    .toBuffer();
  expect(photo.length).toBeGreaterThan(400_000);
  let before = await usageTotals();
  expect((await send(input({ data: photo.toString('base64') }))).statusCode).toBe(503);
  let after = await usageTotals();
  expect(after.calls - before.calls).toBe(1);
  expect(after.estimated - before.estimated).toBe(1);
  expect(after.input - before.input).toBeGreaterThan(320);
  expect(after.input - before.input).toBeLessThan(2_000);
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  before = after;
  expect(
    (
      await send(
        input({ mediaType: 'application/pdf', data: Buffer.from(await pdf.save()).toString('base64') }),
      )
    ).statusCode,
  ).toBe(503);
  after = await usageTotals();
  expect(after.estimated - before.estimated).toBe(1);
  expect(after.input - before.input).toBeGreaterThanOrEqual(3_000);
  expect(after.input - before.input).toBeLessThan(5_000);
});

it('marks a finished reading without reported usage as an estimate', async () => {
  reportUsage = false;
  const response = await send(input());
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().usage).toMatchObject({ tokensEstimated: true });
  expect(response.json().usage.inputTokens).toBeLessThan(2_000);
  reportUsage = true;
  expect((await send(input())).json().usage.tokensEstimated).toBeUndefined();
});

it('refuses a new table when the database label blocks providers, even under permissive field labels', async () => {
  const target = await destination();
  await governance({ kind: 'classification.labels', labels: LABELS });
  await governance({
    kind: 'classification.assign',
    target: { kind: 'database', databaseId: target.databaseId },
    labelId: 'private-import',
  });
  await governance({
    kind: 'classification.assign',
    target: { kind: 'field', databaseId: target.databaseId, fieldId: target.fieldId },
    labelId: 'open-import',
  });
  const response = await send(input({ label: 'public', databaseId: target.databaseId }));
  expect(response.statusCode, response.body).toBe(403);
  expect(response.json().error.messageKey).toBe('governance.classificationDenied');
  expect(requests).toHaveLength(0);
});

it('reads loosely typed cells, short rows, high confidences, and repeated readings', async () => {
  output = {
    columns: [
      { name: 'Item', type: 'text' },
      { name: 'Quantity', type: 'number' },
      { name: 'In stock', type: 'checkbox' },
      { name: 'Note', type: 'text' },
    ],
    rows: [['Pencils', 12, true, null], ['Pens', 3.5], ['Paper']],
    uncertain: [
      [0, 1, 0.95],
      [0, 1, 0.3],
      [1, 1, 0.5],
    ],
  };
  const response = await send(input());
  expect(response.statusCode, response.body).toBe(200);
  const cell = (value: string, confidence = 1) => ({ value, confidence });
  expect(response.json().rows).toEqual([
    [cell('Pencils'), cell('12', 0.8), cell('true'), cell('')],
    [cell('Pens'), cell('3.5', 0.5), cell(''), cell('')],
    [cell('Paper'), cell(''), cell(''), cell('')],
  ]);
  output = { columns: [{ name: 'Item', type: 'text' }], rows: [['Pencils', 'Pens']] };
  expect((await send(input())).statusCode).toBe(422);
});

it('starts the extraction clock when the slot is granted, not while waiting', async () => {
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  DOCUMENT_TIMING.extractionMs = 1_500;
  delay = 1_000;
  const first = extractDocument(server.ctx, actor, input());
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const second = extractDocument(server.ctx, actor, input());
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  expect(requests).toHaveLength(2);
});

it('turns a canceled reading into a quiet error and still counts the consumed input', async () => {
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  delay = 5_000;
  const before = await usageTotals();
  const controller = new AbortController();
  const running = extractDocument(server.ctx, actor, input(), controller.signal);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  controller.abort();
  await expect(running).rejects.toMatchObject({ messageKey: 'import.document.canceled', userFault: true });
  const after = await usageTotals();
  expect(after.calls - before.calls).toBe(1);
  expect(after.estimated - before.estimated).toBe(1);
});

it('frees the slot when an upload is too slow to arrive', async () => {
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  DOCUMENT_TIMING.uploadMs = 100;
  const stalled = (signal: AbortSignal) =>
    new Promise<DocumentImportRequest>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  await expect(extractDocument(server.ctx, actor, stalled)).rejects.toMatchObject({
    messageKey: 'import.document.slowUpload',
    userFault: true,
  });
  const trickle = new PassThrough();
  trickle.write('{"data":"');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/imports/document',
    headers: { ...server.owner.headers, 'content-type': 'application/json' },
    payload: trickle,
  });
  trickle.destroy();
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json().error.messageKey).toBe('import.document.slowUpload');
  expect(requests).toHaveLength(0);
  expect((await extractDocument(server.ctx, actor, input())).rows).toHaveLength(1);
});

it('answers busy to a tool call still waiting when its turn runs out', async () => {
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  // The same person waits for their own reading to finish.
  const colleague = (await actorFor(server.pool, server.schemas, actor.userId, actor.orgId))!;
  colleague.token = { id: randomUUID(), scopes: ['data.records:write'], databases: null };
  DOCUMENT_TIMING.queueMs = 50;
  delay = 500;
  const first = extractDocument(server.ctx, actor, input());
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const result = await callTool(
    {
      app: server.app,
      actor: colleague,
      request: { actor: colleague, log: server.app.log } as unknown as FastifyRequest,
      reader: new RecordReader(server.app),
    },
    'preview_document_import',
    input(),
  );
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ error: { messageKey: 'import.document.busy' } });
  await first;
  expect(requests).toHaveLength(1);
});

it('refuses an empty request without a body or a content type', async () => {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/imports/document',
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(422);
  expect(response.json().error.messageKey).toBe('import.document.invalid');
  expect(requests).toHaveLength(0);
});
