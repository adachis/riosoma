import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { dayIn, newId, type PublicSignatureRequest } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { fileStorage } from '../data/files/storage.js';
import { scanPendingFiles } from '../data/files/scanning.js';
import { eicar, standIn, unreachableScanner } from '../data/files/scan-test-support.js';
import { certificateTime, pageSize, previewDocument, signatureText, stampDocument } from './pdf.js';
import { requestById } from './store.js';
import { documentHash, signingClaims, signingToken } from './token.js';
import { deliverSignatures, signatureReminders } from './worker.js';
import { DAY, harness, helpers, pageText, signers, streams, type Harness } from './test-support.js';

let h: Harness;
let t: ReturnType<typeof helpers>;
beforeAll(async () => {
  h = await harness('signatures');
  t = helpers(h);
}, 60_000);
beforeEach(() => t.resetLimits());
afterAll(async () => {
  await h?.server.close();
  await h?.kit.stop();
});

describe('signature requests', () => {
  it('signs in parallel, preserves original pages, reads stamped text and certificate rows, and emails the attachment', async () => {
    const { server, sent, original } = h;
    const f = await t.fixture();
    const startMail = sent.length;
    const id = await f.start();
    const tokens = await f.tokens(id);
    expect(sent.slice(startMail).map((mail) => mail.to)).toEqual(signers.map((signer) => signer.email));
    const preview = await t.open(tokens[0]!);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers['cache-control']).toBe('no-store');
    expect(preview.json<PublicSignatureRequest>().signers).toEqual(
      signers.map((signer) => ({ name: signer.name, signed: false })),
    );
    expect(preview.body).not.toContain(signers[1]!.email);
    const second = await t.sign(tokens[1]!, 1);
    expect(second.statusCode, second.body).toBe(200);
    expect((await t.open(tokens[1]!)).statusCode).toBe(404);
    const first = await t.sign(tokens[0]!, 0);
    expect(first.statusCode, first.body).toBe(200);
    await t.settle();
    const { summary: request, bytes, attachment, record } = await f.signedFile();
    expect(request.status).toBe('completed');
    expect(record.values[f.fields.file]).toEqual([f.file.id, request.signedAttachmentId]);
    expect(record.values[f.fields.status]).toBe('Completed');
    expect(Date.parse(record.values[f.fields.date] as string)).toBeGreaterThan(Date.now() - 60_000);
    expect(attachment.name).toBe('agreement - signed.pdf');
    const signedPdf = await PDFDocument.load(bytes);
    const originalPdf = await PDFDocument.load(original);
    expect(signedPdf.getPageCount()).toBe(3);
    const row = (await requestById(server.pool, server.schemas, id))!;
    for (let page = 0; page < 2; page++) {
      expect(signedPdf.getPage(page).getSize()).toEqual(originalPdf.getPage(page).getSize());
      for (const stream of streams(originalPdf.getPage(page)))
        expect(streams(signedPdf.getPage(page))).toContain(stream);
      expect(pageText(signedPdf.getPage(page))).toContain(`Approved by signer ${page + 1}`);
      expect(pageText(signedPdf.getPage(page))).toContain(signers[page]!.name);
      expect(pageText(signedPdf.getPage(page))).toContain(`${row.signers[page]!.signedAt!.slice(0, 10)} UTC`);
      expect(streams(signedPdf.getPage(page)).join('')).toContain(' Do');
    }
    const certificate = signedPdf.getPages().slice(2).map(pageText).join(' ').replace(/\s+/g, ' ');
    expect(certificate).toContain('Electronic signature certificate');
    expect(certificate).toContain(`Original document SHA-256 ${documentHash(original)}`);
    for (const signer of row.signers) {
      expect(certificate).toContain(`Signer ${signer.name}`);
      expect(certificate).toContain(`Email ${signer.email}`);
      expect(certificate).toContain(`Signed at ${certificateTime(signer.signedAt!)}`);
      expect(certificate).toContain(`IP address ${signer.ip}`);
      expect(certificate).toContain(`User agent ${signer.userAgent}`);
      expect(certificate).toContain(`Electronic consent ${signer.consent!.replace(/\s+/g, ' ')}`);
    }
    expect(request.finalHash).toBe(documentHash(bytes));
    const completed = sent
      .slice(startMail)
      .filter((mail) => mail.attachments?.some((file) => file.contentType === 'application/pdf'));
    expect(new Set(completed.map((mail) => mail.to))).toEqual(
      new Set([...signers.map((signer) => signer.email), server.owner.email]),
    );
    for (const mail of completed) expect(mail.attachments![0]!.content).toEqual(bytes);
    expect(request.history.map((event) => event.action)).toEqual([
      'sent',
      'sent',
      'opened',
      'signed',
      'signed',
      'completed',
    ]);
    const audit = await query<{ action: string }>(
      server.pool,
      sql`SELECT action FROM ${ident(server.schemas.audit, 'events')}
      WHERE metadata->>'requestId' = ${id} ORDER BY id`,
    );
    expect(audit.rows.map((event) => event.action)).toEqual(
      request.history.map((event) => `signature.${event.action}`),
    );
  });

  it('sets a date field without a time to the day the last signer signed, in their own time zone', async () => {
    const f = await t.fixture();
    await t.command(f.databaseId, {
      kind: 'field.update',
      fieldId: f.fields.date,
      options: { includeTime: false },
    });
    const tokens = await f.tokens(await f.start());
    expect((await t.sign(tokens[0]!, 0)).statusCode).toBe(200);
    // Kiritimati is 14 hours ahead of UTC, so for most of the day its date is a day past UTC's.
    const last = await t.sign(tokens[1]!, 1, { timeZone: 'Pacific/Kiritimati' });
    expect(last.statusCode, last.body).toBe(200);
    await t.settle();
    const [request] = await f.list();
    expect(request!.status).toBe('completed');
    const { values } = await f.record();
    expect(values[f.fields.file]).toEqual([f.file.id, request!.signedAttachmentId]);
    expect(values[f.fields.date]).toBe(dayIn('Pacific/Kiritimati', new Date(request!.signers[1]!.signedAt!)));
  });

  it('enforces sequential order and voids a used, tampered, or rebound token', async () => {
    const { server, sent } = h;
    const f = await t.fixture('sequential');
    const startMail = sent.length;
    const id = await f.start();
    const tokens = await f.tokens(id);
    expect(sent.slice(startMail).map((mail) => mail.to)).toEqual([signers[0]!.email]);
    expect((await t.open(tokens[1]!)).statusCode).toBe(404);
    expect((await t.sign(tokens[1]!, 1)).statusCode).toBe(404);
    const parts = tokens[0]!.split('.');
    parts[1] = tokens[1]!.split('.')[1]!;
    expect((await t.open(parts.join('.'))).statusCode).toBe(404);
    const canonical = tokens[0]!;
    const alias =
      canonical.slice(0, -1) + String.fromCharCode(canonical.charCodeAt(canonical.length - 1) + 1);
    expect(signingClaims(server.ctx.config.secretKey, alias)).toBeNull();
    expect((await t.open(`${tokens[0]!.slice(0, -5)}${randomBytes(5).toString('hex')}`)).statusCode).toBe(
      404,
    );
    expect((await t.sign(tokens[0]!, 0)).statusCode).toBe(200);
    expect((await t.sign(tokens[0]!, 0)).statusCode).toBe(404);
    await t.settle();
    expect(sent.slice(startMail).map((mail) => mail.to)).toEqual(signers.map((signer) => signer.email));
    expect((await t.open(tokens[1]!)).statusCode).toBe(200);
    expect((await t.sign(tokens[1]!, 1)).statusCode).toBe(200);
  });

  it('declines with a reason and voids every link', async () => {
    const f = await t.fixture();
    const tokens = await f.tokens(await f.start());
    const response = await t.decline(tokens[0]!);
    expect(response.statusCode, response.body).toBe(200);
    for (const token of tokens) expect((await t.open(token)).statusCode).toBe(404);
    const [request] = await f.list();
    expect(request?.status).toBe('declined');
    expect(request?.history.at(-1)?.reason).toBe('The dates need updating.');
  });

  it('cancels explicitly and when the source attachment is removed', async () => {
    const { server } = h;
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/signature-requests/${id}/cancel`,
      headers: server.owner.headers,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    for (const token of tokens) expect((await t.open(token)).statusCode).toBe(404);
    const second = await f.start();
    const secondTokens = await f.tokens(second);
    await t.command(f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.recordId, values: { [f.fields.file]: [] } }],
    });
    expect((await f.list()).every((request) => request.status === 'canceled')).toBe(true);
    for (const token of secondTokens) expect((await t.open(token)).statusCode).toBe(404);
  });

  it('refuses expired links, and stops a request whose source bytes changed rather than stamping them', async () => {
    const { server, sent, original } = h;
    const key = randomBytes(32);
    const expired = signingToken(
      key,
      newId('signatureRequest'),
      newId('signatureSigner'),
      new Date(Date.now() - 1000),
    );
    expect(signingClaims(key, expired)).toBeNull();
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    await fileStorage('postgres', server.pool, server.schemas.app, server.ctx.config).delete(f.file.id);
    await fileStorage('postgres', server.pool, server.schemas.app, server.ctx.config).write(
      f.file.id,
      Readable.from([Buffer.concat([original, Buffer.from('\nchanged')])]),
    );
    expect((await t.sign(tokens[0]!, 0)).statusCode).toBe(200);
    const startMail = sent.length;
    const last = await t.sign(tokens[1]!, 1);
    expect(last.statusCode, last.body).toBe(409);
    expect(last.json().error.messageKey).toBe('signatures.stampFailed');
    expect((await t.sign(tokens[1]!, 1)).statusCode).toBe(404);
    await t.settle();
    const [request] = await f.list();
    expect(request?.status).toBe('failed');
    expect(request?.signedAttachmentId).toBeNull();
    expect(request?.history.at(-1)?.action).toBe('failed');
    expect(sent.slice(startMail).map((mail) => [mail.to, mail.subject])).toEqual([
      [server.owner.email, signatureText('failed', { document: 'agreement.pdf' })],
    ]);
    const next = await t.fixture();
    const nextId = await next.start();
    const nextTokens = await next.tokens(nextId);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'signature_requests')} SET expires_at = ${new Date(Date.now() - 1000)} WHERE id = ${nextId}`,
    );
    expect((await t.open(nextTokens[0]!)).statusCode).toBe(404);
    expect((await next.list())[0]?.status).toBe('expired');
  });

  it('requires exact consent and refuses answers for another signer', async () => {
    const f = await t.fixture();
    const tokens = await f.tokens(await f.start());
    expect((await t.sign(tokens[0]!, 0, { consent: false })).statusCode).toBe(422);
    expect((await t.sign(tokens[0]!, 0, { consentText: 'Changed wording' })).statusCode).toBe(422);
    expect((await t.sign(tokens[0]!, 1)).statusCode).toBe(422);
    expect((await t.sign(tokens[0]!, 0, { values: {} })).statusCode).toBe(422);
  });

  it('limits reminders per signer and sends automatic reminders once', async () => {
    const { server } = h;
    const f = await t.fixture('parallel', new Date(Date.now() + 2 * DAY).toISOString());
    const id = await f.start();
    const [request] = await f.list();
    const reminder = () =>
      server.app.inject({
        method: 'POST',
        url: `/api/signature-requests/${id}/remind`,
        headers: server.owner.headers,
        payload: { signerId: request!.signers[0]!.id },
      });
    expect((await reminder()).statusCode).toBe(200);
    expect((await reminder()).statusCode).toBe(429);
    await signatureReminders(server.ctx);
    await deliverSignatures(server.ctx);
    await signatureReminders(server.ctx);
    expect((await f.list())[0]!.history.filter((event) => event.action === 'reminded')).toHaveLength(2);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'signature_requests')}
      SET signers = jsonb_set(signers, '{0,lastReminder}', ${JSON.stringify(new Date(Date.now() - DAY - 1000).toISOString())}::jsonb) WHERE id = ${id}`,
    );
    expect((await reminder()).statusCode).toBe(200);
  });

  it('quarantines the signed attachment and sends it only after a clean scan', async () => {
    const { server, sent, signature } = h;
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    const scanner = await standIn();
    const startMail = sent.length;
    server.ctx.config.clamavUrl = scanner.url;
    try {
      const infected = `data:image/png;base64,${Buffer.concat([Buffer.from(signature.split(',')[1]!, 'base64'), eicar]).toString('base64')}`;
      const refused = await t.sign(tokens[0]!, 0, {
        values: {
          'field-0-signature': { image: infected },
          'field-0-initials': { image: signature },
          'field-0-text': { text: 'Approved' },
        },
      });
      expect(refused.statusCode, refused.body).toBe(422);
      expect((await f.list())[0]!.signers[0]!.status).toBe('pending');
      expect((await t.sign(tokens[0]!, 0)).statusCode).toBe(200);
      const response = await t.sign(tokens[1]!, 1);
      expect(response.statusCode, response.body).toBe(200);
      await t.settle();
      const row = (await requestById(server.pool, server.schemas, id))!;
      expect(row.status).toBe('completed');
      const file = await query<{ scan_state: string }>(
        server.pool,
        sql`SELECT scan_state FROM ${ident(server.schemas.app, 'files')} WHERE id = ${row.signed_file_id}`,
      );
      expect(file.rows[0]?.scan_state).toBe('quarantined');
      expect(sent.slice(startMail)).toHaveLength(0);
      await scanPendingFiles(server.app);
      await deliverSignatures(server.ctx);
      expect(sent.slice(startMail)).toHaveLength(3);
    } finally {
      server.ctx.config.clamavUrl = undefined;
      await scanner.close();
    }
  });

  it('uses the organization scanner controls for signature images', async () => {
    const { server, signature } = h;
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    const scanner = await standIn();
    server.config.clamavApprovedUrls = [scanner.url];
    const configureScanner = (enabled: boolean) =>
      server.app.inject({
        method: 'PUT',
        url: '/api/org/files/scanner',
        headers: server.owner.headers,
        payload: { enabled, address: scanner.url, oversizedPolicy: 'quarantine' },
      });
    try {
      const enabled = await configureScanner(true);
      expect(enabled.statusCode, enabled.body).toBe(200);
      const infected = `data:image/png;base64,${Buffer.concat([Buffer.from(signature.split(',')[1]!, 'base64'), eicar]).toString('base64')}`;
      const refused = await t.sign(tokens[0]!, 0, {
        values: {
          'field-0-signature': { image: infected },
          'field-0-initials': { image: signature },
          'field-0-text': { text: 'Approved' },
        },
      });
      expect(refused.statusCode, refused.body).toBe(422);
      expect((await f.list())[0]!.signers[0]!.status).toBe('pending');
      expect(scanner.received).toHaveLength(2);
      server.config.clamavApprovedUrls = [];
      const revoked = await t.sign(tokens[0]!, 0);
      expect(revoked.statusCode, revoked.body).toBe(403);
      expect(scanner.received).toHaveLength(2);
      expect((await f.list())[0]!.signers[0]!.status).toBe('pending');
      server.config.clamavApprovedUrls = [scanner.url];
      const disabled = await configureScanner(false);
      expect(disabled.statusCode, disabled.body).toBe(200);
      server.ctx.config.clamavUrl = await unreachableScanner();
      const signed = await t.sign(tokens[0]!, 0);
      expect(signed.statusCode, signed.body).toBe(200);
      expect(scanner.received).toHaveLength(2);
    } finally {
      delete server.config.clamavApprovedUrls;
      server.ctx.config.clamavUrl = undefined;
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'orgs')}
          SET settings = settings - 'fileScanner' - 'fileScannerStatus' WHERE id = ${server.owner.info.org.id}`,
      );
      await scanner.close();
    }
  });

  it('refuses a limited editor on a record outside their rules', async () => {
    const { server } = h;
    const f = await t.fixture();
    const editor = await server.addMember({ name: 'Limited editor' });
    await t.grant(f.databaseId, editor.userId, 'editor');
    const rule = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${f.tableId}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['editor'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'visible', fieldId: f.fields.name, operator: 'is', value: 'Visible only' }],
            },
          },
        ],
      },
    });
    expect(rule.statusCode, rule.body).toBe(200);
    expect((await f.request(editor)).statusCode).toBe(404);
  });

  it('serializes simultaneous submissions and completes only once', async () => {
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    const same = await Promise.all([t.sign(tokens[0]!, 0), t.sign(tokens[0]!, 0)]);
    expect(same.map((response) => response.statusCode).sort()).toEqual([200, 404]);
    expect((await t.sign(tokens[1]!, 1)).statusCode).toBe(200);
    await t.settle();
    const [request] = await f.list();
    expect(request!.history.filter((event) => event.action === 'signed')).toHaveLength(2);
    expect(request!.history.filter((event) => event.action === 'completed')).toHaveLength(1);
  });

  it('completes once when the last two signers finish at the same moment', async () => {
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    const both = await Promise.all([t.sign(tokens[0]!, 0), t.sign(tokens[1]!, 1)]);
    expect(both.map((response) => response.statusCode)).toEqual([200, 200]);
    await t.settle();
    const [request] = await f.list();
    expect(request!.status).toBe('completed');
    expect(request!.history.filter((event) => event.action === 'completed')).toHaveLength(1);
    expect((await f.record()).values[f.fields.file]).toEqual([f.file.id, request!.signedAttachmentId]);
    expect(id).toBe(request!.id);
  });

  it('retries failed email without recording delivery or allowing duplicate pending reminders', async () => {
    const { server } = h;
    const f = await t.fixture();
    const mailer = server.ctx.mailer;
    server.ctx.mailer = {
      async send() {
        throw new Error('Mail unavailable');
      },
    };
    let id: string;
    try {
      id = await f.start();
      expect((await f.list())[0]!.history).toEqual([]);
    } finally {
      server.ctx.mailer = mailer;
    }
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'signature_deliveries')} SET next_at = now() WHERE request_id = ${id!}`,
    );
    await deliverSignatures(server.ctx);
    const [request] = await f.list();
    expect(request!.history.map((event) => event.action)).toEqual(['sent', 'sent']);
    server.ctx.mailer = {
      async send() {
        throw new Error('Mail unavailable');
      },
    };
    const remind = () =>
      server.app.inject({
        method: 'POST',
        url: `/api/signature-requests/${id!}/remind`,
        headers: server.owner.headers,
        payload: { signerId: request!.signers[0]!.id },
      });
    try {
      expect((await remind()).statusCode).toBe(200);
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'signature_requests')}
        SET signers = jsonb_set(signers, '{0,lastReminder}', ${JSON.stringify(new Date(Date.now() - 2 * DAY).toISOString())}::jsonb) WHERE id = ${id!}`,
      );
      expect((await remind()).statusCode).toBe(429);
      expect((await f.list())[0]!.history.filter((event) => event.action === 'reminded')).toHaveLength(0);
    } finally {
      server.ctx.mailer = mailer;
    }
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'signature_deliveries')} SET next_at = now() WHERE request_id = ${id!}`,
    );
    await deliverSignatures(server.ctx);
    expect((await f.list())[0]!.history.filter((event) => event.action === 'reminded')).toHaveLength(1);
    expect((await remind()).statusCode).toBe(429);
  });

  it('applies token and address limits independently', async () => {
    const { server } = h;
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    const response = await server.app.inject({
      url: t.publicUrl('', tokens[0]!),
      remoteAddress: '198.51.100.44',
    });
    expect(response.statusCode).toBe(200);
    await query(server.pool, sql`UPDATE ${ident(server.schemas.app, 'signature_attempts')} SET count = 1000`);
    const sameToken = await server.app.inject({
      url: t.publicUrl('', tokens[0]!),
      remoteAddress: '198.51.100.45',
    });
    expect(sameToken.statusCode).toBe(429);
    const sameAddress = await server.app.inject({
      url: t.publicUrl('', tokens[1]!),
      remoteAddress: '198.51.100.44',
    });
    expect(sameAddress.statusCode).toBe(429);
  });

  it('cancels when stored source metadata is deleted and rechecks requester permissions', async () => {
    const { server } = h;
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    await query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'files')} WHERE id = ${f.file.id}`);
    expect((await f.list())[0]?.status).toBe('canceled');
    expect((await t.open(tokens[0]!)).statusCode).toBe(404);
    const next = await t.fixture();
    const nextTokens = await next.tokens(await next.start());
    await query(
      server.pool,
      sql`DELETE FROM ${ident(server.schemas.app, 'grants')} WHERE resource_id = ${next.databaseId}`,
    );
    expect((await t.open(nextTokens[0]!)).statusCode).toBe(404);
    expect((await t.sign(nextTokens[0]!, 0)).statusCode).toBe(404);
  });

  it('uses matching preview and stamp coordinates on cropped, rotated pages', async () => {
    const { server, original, signature } = h;
    const source = await PDFDocument.load(original);
    source.getPage(0).setCropBox(10, 20, 500, 700);
    source.getPage(0).setRotation(degrees(90));
    const bytes = Buffer.from(await source.save());
    const f = await t.fixture();
    const row = (await requestById(server.pool, server.schemas, await f.start()))!;
    row.signers.forEach((signer, index) => {
      signer.signedAt = new Date().toISOString();
      signer.consent = signatureText('consent');
      signer.ip = '198.51.100.9';
      signer.userAgent = 'Signing test browser';
      signer.values = {
        [`field-${index}-signature`]: { image: signature, text: '' },
        [`field-${index}-initials`]: { image: signature, text: '' },
        [`field-${index}-text`]: { text: 'Approved' },
      };
    });
    const preview = await PDFDocument.load(await previewDocument(bytes, row.input.fields, { onlyPage: 0 }));
    const final = await PDFDocument.load(
      (await stampDocument(bytes, documentHash(bytes), row.input.fields, row.signers)).bytes,
    );
    expect(pageSize(preview.getPage(0))).toEqual({ width: 700, height: 500 });
    expect(final.getPage(0).getCropBox()).toEqual(source.getPage(0).getCropBox());
    expect(final.getPage(0).getRotation().angle).toBe(90);
    for (const page of [preview.getPage(0), final.getPage(0)])
      expect(streams(page).join('')).toContain('0 1 -1 0 510 20 cm');
    expect(pageText(final.getPage(0))).toContain('Approved');
  });
});
