import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ClassificationRules, newId, type GovernanceAction } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { downloadToken } from './token.js';
import { deliverSignatures } from './worker.js';
import { harness, helpers, type Harness } from './test-support.js';

let h: Harness;
let t: ReturnType<typeof helpers>;
beforeAll(async () => {
  h = await harness('signature_governance');
  t = helpers(h);
}, 60_000);
beforeEach(() => t.resetLimits());
afterAll(async () => {
  await h?.server.close();
  await h?.kit.stop();
});

async function govern(action: GovernanceAction) {
  const response = await h.server.app.inject({
    method: 'POST',
    url: '/api/admin/governance/commands',
    headers: h.server.owner.headers,
    payload: { kind: 'governance.apply', id: newId('command'), action },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().status, response.body).toBe('applied');
}

it.each(['noExport', 'noExternalSharing', 'noPublicLinks', 'maskGuests'] as const)(
  'rechecks %s when requesting, sending, viewing, downloading, and signing a document',
  async (rule) => {
    const f = await t.fixture();
    const requestId = await f.start();
    await t.settle();
    const [token] = await f.tokens(requestId);
    expect((await t.open(token!)).statusCode).toBe(200);
    expect((await t.document(token!)).statusCode).toBe(200);
    await govern({
      kind: 'classification.labels',
      labels: [
        {
          id: 'document',
          name: 'Document',
          color: 'blue',
          description: '',
          rules: ClassificationRules.parse({ [rule]: true }),
        },
      ],
    });
    await govern({
      kind: 'classification.assign',
      target: { kind: 'field', databaseId: f.databaseId, fieldId: f.fields.file },
      labelId: 'document',
    });
    const requested = await f.request();
    expect.soft(requested.statusCode, requested.body).toBe(403);
    expect.soft((await t.open(token!)).statusCode).toBe(404);
    expect.soft((await t.document(token!)).statusCode).toBe(404);
    expect.soft((await t.sign(token!, 0)).statusCode).toBe(404);
    await query(
      h.server.pool,
      sql`UPDATE ${ident(h.server.schemas.app, 'signature_deliveries')}
      SET sent_at = NULL, next_at = now() WHERE request_id = ${requestId} AND kind = 'invitation'`,
    );
    const sent = h.sent.length;
    await deliverSignatures(h.server.ctx);
    expect(h.sent.length).toBe(sent);
    await govern({
      kind: 'classification.assign',
      target: { kind: 'field', databaseId: f.databaseId, fieldId: f.fields.file },
      labelId: null,
    });
    expect((await t.open(token!)).statusCode).toBe(200);
    expect((await t.document(token!)).statusCode).toBe(200);
  },
);

it('rechecks classification before delivering and downloading completed documents', async () => {
  const f = await t.fixture();
  const id = await f.start();
  await t.settle();
  const tokens = await f.tokens(id);
  expect((await t.sign(tokens[0]!, 0)).statusCode).toBe(200);
  expect((await t.sign(tokens[1]!, 1)).statusCode).toBe(200);
  await t.settle();
  const token = downloadToken(h.server.ctx.config.secretKey, id, new Date(Date.now() + 86_400_000));
  const download = () =>
    h.server.app.inject({ url: t.publicUrl('/download', token), remoteAddress: t.address() });
  expect((await download()).statusCode).toBe(200);
  await govern({
    kind: 'classification.labels',
    labels: [
      {
        id: 'document',
        name: 'Document',
        color: 'blue',
        description: '',
        rules: ClassificationRules.parse({ noExport: true }),
      },
    ],
  });
  await govern({
    kind: 'classification.assign',
    target: { kind: 'field', databaseId: f.databaseId, fieldId: f.fields.file },
    labelId: 'document',
  });
  expect.soft((await download()).statusCode).toBe(404);
  await query(
    h.server.pool,
    sql`UPDATE ${ident(h.server.schemas.app, 'signature_deliveries')}
    SET sent_at = NULL, next_at = now() WHERE request_id = ${id} AND kind = 'completed'`,
  );
  const sent = h.sent.length;
  await deliverSignatures(h.server.ctx);
  expect(h.sent.length).toBe(sent);
});
