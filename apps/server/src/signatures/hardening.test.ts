import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';
import { newId, type PublicSignatureRequest } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { certificateTime, signatureText } from './pdf.js';
import { requestById } from './store.js';
import { deliverSignatures } from './worker.js';
import { PUBLIC_LIMITS } from './routes.js';
import {
  clips,
  harness,
  helpers,
  near,
  pageForms,
  pageText,
  signers,
  textRuns,
  type Harness,
} from './test-support.js';

let h: Harness;
let t: ReturnType<typeof helpers>;
beforeAll(async () => {
  h = await harness('sighard');
  t = helpers(h);
}, 60_000);
beforeEach(() => t.resetLimits());
afterAll(async () => {
  await h?.server.close();
  await h?.kit.stop();
});

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Where a fixture field lands on a 612 by 792 page, in PDF points. */
function box(field: { x: number; y: number; width: number; height: number }) {
  return [field.x * 612, (1 - field.y - field.height) * 792, field.width * 612, field.height * 792];
}

/** Holds a database's command lock from another connection while the work runs. */
async function holdingDatabaseLock<T>(databaseId: string, work: () => Promise<T>): Promise<T> {
  const client = await h.server.pool.connect();
  const key = `${h.server.schemas.app}:database:${databaseId}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
    return await work();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
    client.release();
  }
}

/** The work's result, or 'blocked' when it waits past the limit. */
async function within<T>(work: Promise<T>, ms = 5_000): Promise<T | 'blocked'> {
  let timer: NodeJS.Timeout | undefined;
  const blocked = new Promise<'blocked'>((resolve) => {
    timer = setTimeout(() => resolve('blocked'), ms);
  });
  try {
    return await Promise.race([work, blocked]);
  } finally {
    clearTimeout(timer);
  }
}

describe('stamping text', () => {
  it('refuses text over 500 characters, strips noncharacters and controls, and wraps and clips text inside its box', async () => {
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    const answer = (text: string) => ({
      values: {
        'field-0-signature': { image: h.signature },
        'field-0-initials': { image: h.signature },
        'field-0-text': { text },
      },
    });
    for (const text of ['a'.repeat(501), '日'.repeat(600), 'Ж'.repeat(520)]) {
      const refused = await t.sign(tokens[0]!, 0, answer(text));
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json().error.messageKey).toBe('signatures.textTooLong');
    }
    const long = Array.from({ length: 80 }, (_, index) => `word${index % 10}`).join(' ');
    expect(long.length).toBeLessThanOrEqual(500);
    expect((await t.sign(tokens[0]!, 0, answer(`Approved \uFFFF\u0007 ${'\uFDD0'}now`))).statusCode).toBe(
      200,
    );
    const last = await t.sign(tokens[1]!, 1, {
      values: {
        'field-1-signature': { image: h.signature },
        'field-1-initials': { image: h.signature },
        'field-1-text': { text: long },
      },
    });
    expect(last.statusCode, last.body).toBe(200);
    await t.settle();
    const row = (await requestById(h.server.pool, h.server.schemas, id))!;
    expect(row.status).toBe('completed');
    expect(row.signers[0]!.values['field-0-text']!.text).toBe('Approved now');
    const signed = await PDFDocument.load((await f.signedFile()).bytes);
    for (const [page, index] of [
      [0, 0],
      [1, 1],
    ] as const)
      for (const kind of ['signature', 'initials', 'name', 'date', 'text']) {
        const field = row.input.fields.find((field) => field.id === `field-${index}-${kind}`)!;
        const expected = box(field);
        expect(
          clips(signed.getPage(page)).some((clip) => clip.every((value, at) => near(value, expected[at]!))),
          `${kind} on page ${page + 1} is clipped to its box`,
        ).toBe(true);
      }
    const textBox = box(row.input.fields.find((field) => field.id === 'field-1-text')!);
    const lines = textRuns(signed.getPage(1)).filter((run) => run.text.startsWith('word'));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((run) => run.text).join(' ')).toBe(long);
    for (const run of lines) {
      expect(run.x).toBeGreaterThanOrEqual(textBox[0]!);
      expect(run.y).toBeGreaterThanOrEqual(textBox[1]!);
      expect(run.y).toBeLessThanOrEqual(textBox[1]! + textBox[3]!);
    }
    expect(pageText(signed.getPage(0))).toContain('Approved now');
  });

  it('stamps 500 characters outside the standard font within the box', async () => {
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    for (const [index, text] of ['Ж'.repeat(500), '日'.repeat(500)].entries()) {
      const response = await t.sign(tokens[index]!, index, {
        values: {
          [`field-${index}-signature`]: { image: h.signature },
          [`field-${index}-initials`]: { image: h.signature },
          [`field-${index}-text`]: { text },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    await t.settle();
    expect((await requestById(h.server.pool, h.server.schemas, id))!.status).toBe('completed');
  });
});

describe('the certificate', () => {
  it('collapses signer-supplied text into labeled rows that no value can imitate', async () => {
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    const pad = (value: string, width: number) => value.padEnd(width, ' ');
    const forged = [
      pad('Mozilla/5.0 (Macintosh)', 78),
      pad('Signer: Taylor Boss <ceo@example.test>', 90),
      pad('Signed at: 2026-01-01T00:00:00.000Z', 90),
      pad('IP address: 203.0.113.250', 90),
      'User agent: Mozilla/5.0 Email\tceo@example.test',
    ].join('');
    expect((await t.sign(tokens[0]!, 0, {}, { 'user-agent': forged })).statusCode).toBe(200);
    expect((await t.sign(tokens[1]!, 1)).statusCode).toBe(200);
    await t.settle();
    const row = (await requestById(h.server.pool, h.server.schemas, id))!;
    expect(row.signers[0]!.userAgent).toBe(forged.replace(/\s+/g, ' ').slice(0, 200).trim());
    expect(forged.length).toBeGreaterThan(200);
    expect(row.signers[0]!.userAgent!.length).toBeLessThanOrEqual(200);
    const signed = await PDFDocument.load((await f.signedFile()).bytes);
    const runs = signed.getPages().slice(2).flatMap(textRuns);
    const labels = new Set(
      (
        ['originalHash', 'signer', 'email', 'time', 'zone', 'address', 'browser', 'consentRecorded'] as const
      ).map((key) => signatureText(key)),
    );
    const wording = [signatureText('certificate'), signatureText('simple'), signatureText('hashNote')].join(
      ' ',
    );
    for (const run of runs.filter((run) => near(run.x, 36))) {
      if (labels.has(run.text)) continue;
      expect(wording, `"${run.text}" starts a line of the certificate`).toContain(run.text);
    }
    const agent = runs.filter((run) => run.text.includes('Taylor Boss') || run.text.includes('Mozilla'));
    expect(agent.length).toBeGreaterThan(0);
    for (const run of agent) expect(near(run.x, 196)).toBe(true);
    const values = runs.filter((run) => near(run.x, 196));
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((run) => !/\s{2}|\t/.test(run.text))).toBe(true);
  });

  it('states only the original hash, which matches the source, and emails the signed file’s own hash', async () => {
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    const startMail = h.sent.length;
    expect((await t.sign(tokens[0]!, 0)).statusCode).toBe(200);
    expect((await t.sign(tokens[1]!, 1)).statusCode).toBe(200);
    await t.settle();
    const { bytes, summary } = await f.signedFile();
    const source = await h.server.app.inject({ url: f.file.url, headers: h.server.owner.headers });
    expect(source.statusCode).toBe(200);
    const signed = await PDFDocument.load(bytes);
    const certificate = signed.getPages().slice(2).map(pageText).join(' ');
    expect(certificate.match(/[0-9a-f]{64}/g)).toEqual([sha256(source.rawPayload)]);
    expect(certificate).not.toContain('before this certificate');
    expect(certificate.replace(/\s+/g, ' ')).toContain(signatureText('hashNote').replace(/\s+/g, ' '));
    expect(summary.finalHash).toBe(sha256(bytes));
    const completed = h.sent.slice(startMail).filter((mail) => mail.attachments?.length);
    expect(completed).toHaveLength(3);
    for (const mail of completed) {
      expect(mail.text).toContain(sha256(bytes));
      expect(mail.html).toContain(sha256(bytes));
    }
  });
});

describe('locks and limits', () => {
  it('opens, shows, signs, and declines while the database lock is held elsewhere, and sends mail outside every lock', async () => {
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    const other = await f.start();
    const otherTokens = await f.tokens(other);
    await holdingDatabaseLock(f.databaseId, async () => {
      for (const response of [
        await within(t.open(tokens[0]!)),
        await within(t.document(tokens[0]!)),
        await within(t.sign(tokens[0]!, 0)),
        await within(t.sign(tokens[1]!, 1)),
        await within(t.decline(otherTokens[0]!)),
      ])
        expect(response === 'blocked' ? response : response.statusCode).toBe(200);
    });
    await t.settle();
    expect((await requestById(h.server.pool, h.server.schemas, id))!.status).toBe('completed');
    const checks: Array<{ databaseFree: boolean; rowFree: boolean }> = [];
    const mailer = h.server.ctx.mailer;
    h.server.ctx.mailer = {
      async send(message) {
        const requestId = /<signature-(sgr[0-9A-Za-z]+)-/.exec(message.headers!['Message-ID']!)![1]!;
        const row = (await requestById(h.server.pool, h.server.schemas, requestId))!;
        const client = await h.server.pool.connect();
        try {
          const key = `${h.server.schemas.app}:database:${row.database_id}`;
          const free = await client.query<{ free: boolean }>(
            'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS free',
            [key],
          );
          if (free.rows[0]!.free)
            await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
          await client.query('BEGIN');
          const rowFree = await client
            .query(
              `SELECT 1 FROM "${h.server.schemas.app}".signature_requests WHERE id = $1 FOR UPDATE NOWAIT`,
              [requestId],
            )
            .then(
              () => true,
              () => false,
            );
          await client.query('ROLLBACK');
          checks.push({ databaseFree: free.rows[0]!.free, rowFree });
        } finally {
          client.release();
        }
        return mailer!.send(message);
      },
    };
    try {
      const next = await t.fixture('sequential');
      const nextTokens = await next.tokens(await next.start());
      expect((await t.sign(nextTokens[0]!, 0)).statusCode).toBe(200);
      await t.settle();
    } finally {
      h.server.ctx.mailer = mailer;
    }
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(checks.every((check) => check.databaseFree && check.rowFree)).toBe(true);
  });

  it('limits each link to 20 public requests a minute and each address to 30', async () => {
    expect(PUBLIC_LIMITS).toEqual({ address: 30, token: 20 });
    const f = await t.fixture();
    const [token] = await f.tokens(await f.start());
    for (let count = 0; count < 20; count++) expect((await t.open(token!)).statusCode).toBe(200);
    expect((await t.open(token!)).statusCode).toBe(429);
    const address = '198.51.100.77';
    for (let count = 0; count < 30; count++) {
      const response = await h.server.app.inject({
        url: t.publicUrl('', `unknown-${count}`),
        remoteAddress: address,
      });
      expect(response.statusCode).toBe(404);
    }
    const limited = await h.server.app.inject({ url: t.publicUrl('', 'unknown'), remoteAddress: address });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.messageKey).toBe('signatures.rateLimited');
  });

  it('limits each person to 20 requests an hour and 200 signers a day, as settings', async () => {
    const f = await t.fixture();
    const editor = await h.server.addMember({ name: 'Busy editor' });
    await t.grant(f.databaseId, editor.userId, 'editor');
    const config = h.server.ctx.config;
    const saved = { ...config };
    try {
      config.signatureRequestHourlyLimit = 2;
      expect((await f.request(editor)).statusCode).toBe(200);
      expect((await f.request(editor)).statusCode).toBe(200);
      const third = await f.request(editor);
      expect(third.statusCode).toBe(429);
      expect(third.json().error.messageKey).toBe('signatures.requestLimit');
      config.signatureRequestHourlyLimit = 100;
      config.signatureSignerDailyLimit = 5;
      const signersOver = await f.request(editor);
      expect(signersOver.statusCode).toBe(429);
      expect(signersOver.json().error.messageKey).toBe('signatures.signerLimit');
      config.signatureSignerDailyLimit = 6;
      expect((await f.request(editor)).statusCode).toBe(200);
    } finally {
      config.signatureRequestHourlyLimit = saved.signatureRequestHourlyLimit;
      config.signatureSignerDailyLimit = saved.signatureSignerDailyLimit;
    }
  });
});

describe('permissions', () => {
  it('shows a record’s requests only to people who can edit it', async () => {
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    expect((await t.decline(tokens[1]!, 'Private reason from Morgan')).statusCode).toBe(200);
    for (const role of ['reader', 'commenter']) {
      const member = await h.server.addMember({ name: `A ${role}` });
      await t.grant(f.databaseId, member.userId, role);
      const response = await h.server.app.inject({ url: f.url, headers: member.headers });
      expect(response.statusCode, `${role} lists requests`).toBe(403);
      expect(response.body).not.toContain('morgan@example.test');
      expect(response.body).not.toContain('Private reason');
    }
    const editor = await h.server.addMember({ name: 'An editor' });
    await t.grant(f.databaseId, editor.userId, 'editor');
    expect((await f.list(editor))[0]?.signers[1]?.reason).toBe('Private reason from Morgan');
  });

  it('refuses hidden, missing, and wrong-type completion fields with one answer', async () => {
    const f = await t.fixture();
    const editor = await h.server.addMember({ name: 'Restricted editor' });
    await t.grant(f.databaseId, editor.userId, 'editor');
    for (const fieldId of [f.fields.status, f.fields.date]) {
      const restrict = await h.server.app.inject({
        method: 'PUT',
        url: `/api/fields/${fieldId}/permissions`,
        headers: h.server.owner.headers,
        payload: { restricted: { roles: [], users: [] }, locked: null },
      });
      expect(restrict.statusCode, restrict.body).toBe(200);
    }
    const answers = [];
    for (const changes of [
      { statusFieldId: f.fields.status },
      { statusFieldId: f.fields.date },
      { statusFieldId: newId('field') },
      { statusFieldId: f.fields.name, dateFieldId: f.fields.date },
      { statusFieldId: f.fields.name, dateFieldId: f.fields.status },
      { statusFieldId: f.fields.name, dateFieldId: newId('field') },
    ]) {
      const response = await f.request(editor, changes);
      answers.push([response.statusCode, response.json().error?.messageKey]);
    }
    expect(answers).toEqual(Array.from({ length: 6 }, () => [422, 'signatures.invalidField']));
  });

  it('answers the same 404 on public links when the requester loses access', async () => {
    const f = await t.fixture();
    const editor = await h.server.addMember({ name: 'Former editor' });
    await t.grant(f.databaseId, editor.userId, 'editor');
    const tokens = await f.tokens(await f.start(editor));
    expect((await t.open(tokens[0]!)).statusCode).toBe(200);
    await query(
      h.server.pool,
      sql`UPDATE ${ident(h.server.schemas.app, 'grants')} SET role = 'reader' WHERE principal_id = ${editor.userId}`,
    );
    for (const response of [
      await t.open(tokens[0]!),
      await t.document(tokens[0]!),
      await t.sign(tokens[0]!, 0),
      await t.decline(tokens[0]!),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.messageKey).toBe('signatures.unavailable');
    }
  });
});

describe('what signers see and receive', () => {
  it('shows every placed field, labels other signers’ fields, and refuses overlapping fields', async () => {
    const f = await t.fixture();
    const tokens = await f.tokens(await f.start());
    const view = (await t.open(tokens[0]!)).json<PublicSignatureRequest>();
    expect(view.fields.map((field) => field.id)).toEqual(
      f.input.fields.filter((field) => field.signer === 0).map((field) => field.id),
    );
    expect(view.otherFields).toEqual(
      f.input.fields
        .filter((field) => field.signer === 1)
        .map(({ page, x, y, width, height }) => ({ page, x, y, width, height, signerName: 'Morgan Lee' })),
    );
    expect(JSON.stringify(view)).not.toContain('morgan@example.test');
    const preview = await PDFDocument.load((await t.document(tokens[0]!)).rawPayload);
    expect(pageText(preview.getPage(1))).toContain('For Morgan Lee');
    expect(pageText(preview.getPage(0))).not.toContain('For Morgan Lee');
    const overlapping = await f.request(h.server.owner, {
      fields: [...f.input.fields, { ...f.input.fields[5]!, id: 'field-0-over', signer: 0, x: 0.3 }],
    });
    expect(overlapping.statusCode, overlapping.body).toBe(422);
    expect(overlapping.json().error.messageKey).toBe('signatures.overlap');
  });

  it('removes scripts, automatic actions, and form fields, flattening what the fields showed, and refuses XFA', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const pages = ['Original agreement, page one', 'Original agreement, page two'].map((text) => {
      const page = pdf.addPage([612, 792]);
      page.drawText(text, { x: 30, y: 740, font, size: 14 });
      return page;
    });
    const script = (code: string) =>
      pdf.context.register(pdf.context.obj({ Type: 'Action', S: 'JavaScript', JS: PDFString.of(code) }));
    pdf.catalog.set(PDFName.of('OpenAction'), script('app.alert(1)'));
    pdf.catalog.set(PDFName.of('AA'), pdf.context.obj({ WC: script('app.alert(2)') }));
    pdf.catalog.set(
      PDFName.of('Names'),
      pdf.context.obj({
        JavaScript: pdf.context.obj({ Names: [PDFHexString.fromText('boot'), script('app.alert(3)')] }),
      }),
    );
    pages[0]!.node.set(PDFName.of('AA'), pdf.context.obj({ O: script('app.alert(4)') }));
    const amount = pdf.getForm().createTextField('amount');
    amount.setText('100');
    amount.addToPage(pages[0]!, { x: 60, y: 660, width: 310, height: 55 });
    const links = [
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [30, 30, 90, 50],
          A: script('app.alert(5)'),
        }),
      ),
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [100, 30, 160, 50],
          A: pdf.context.obj({ S: 'URI', URI: PDFString.of('https://example.test/terms') }),
        }),
      ),
    ];
    const annotations = pages[0]!.node.Annots()!;
    for (const link of links) annotations.push(link);
    const source = Buffer.from(await pdf.save({ useObjectStreams: false }));
    expect(source.toString('latin1')).toContain('/JavaScript');
    const f = await t.fixture('parallel', null, source);
    const tokens = await f.tokens(await f.start());
    const preview = (await t.document(tokens[0]!)).rawPayload.toString('latin1');
    for (const marker of ['/JavaScript', 'app.alert', '/OpenAction', '/AcroForm', '/Widget'])
      expect(preview).not.toContain(marker);
    expect((await t.sign(tokens[0]!, 0)).statusCode).toBe(200);
    expect((await t.sign(tokens[1]!, 1)).statusCode).toBe(200);
    await t.settle();
    const { bytes } = await f.signedFile();
    const raw = bytes.toString('latin1');
    for (const marker of ['/JavaScript', 'app.alert', '/OpenAction', '/AcroForm', '/Widget', '/AA '])
      expect(raw, marker).not.toContain(marker);
    const signed = await PDFDocument.load(bytes);
    expect(signed.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    expect(signed.catalog.has(PDFName.of('OpenAction'))).toBe(false);
    expect(signed.getForm().getFields()).toEqual([]);
    const first = signed.getPage(0);
    // Both links stay, but only the one that opens an address keeps its action.
    const kept = first.node
      .Annots()!
      .asArray()
      .map((ref) => signed.context.lookup(ref) as PDFDict);
    expect(kept.map((link) => link.lookup(PDFName.of('Subtype')))).toEqual([
      PDFName.of('Link'),
      PDFName.of('Link'),
    ]);
    expect(kept.map((link) => link.has(PDFName.of('A')))).toEqual([false, true]);
    expect(raw).toContain('https://example.test/terms');
    const flattened = pageForms(first).filter((form) => form.name.startsWith('FlatWidget'));
    expect(flattened).toHaveLength(1);
    expect(flattened[0]!.content).toMatch(/\(100\)|<313030>/);
    expect(pageText(first)).toContain('Approved by signer 1');

    const xfa = await PDFDocument.create();
    xfa.addPage([612, 792]);
    xfa.addPage([612, 792]);
    xfa.catalog.set(
      PDFName.of('AcroForm'),
      xfa.context.obj({ Fields: [], XFA: PDFString.of('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>') }),
    );
    const withXfa = await t.fixture('parallel', null, Buffer.from(await xfa.save()));
    const refused = await withXfa.request();
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().error.messageKey).toBe('signatures.xfa');
  });

  it('removes embedded files, associated files, and file attachment annotations from signed copies and previews', async () => {
    const pdf = await PDFDocument.load(h.original);
    const { context } = pdf;
    const payloads: Buffer[] = [];
    const file = () => {
      const payload = Buffer.from(`Unseen attachment ${randomBytes(24).toString('hex')}`);
      payloads.push(payload);
      const stream =
        payloads.length % 2
          ? context.stream(payload, { Type: 'EmbeddedFile' })
          : context.flateStream(payload, { Type: 'EmbeddedFile' });
      return context.register(
        context.obj({
          Type: 'Filespec',
          F: PDFString.of(`attachment-${payloads.length}.txt`),
          AFRelationship: 'Data',
          EF: { F: context.register(stream) },
        }),
      );
    };
    pdf.catalog.set(
      PDFName.of('Names'),
      context.register(
        context.obj({
          EmbeddedFiles: context.register(
            context.obj({ Names: [PDFString.of('catalog-attachment.txt'), file()] }),
          ),
          Dests: { Names: [PDFString.of('start'), [pdf.getPage(0).ref, 'Fit']] },
        }),
      ),
    );
    pdf.catalog.set(PDFName.of('AF'), context.register(context.obj([file()])));
    for (const page of pdf.getPages()) {
      page.node.set(PDFName.of('AF'), context.obj([file()]));
      page.node.set(
        PDFName.of('Annots'),
        context.obj([
          context.register(
            context.obj({
              Type: 'Annot',
              Subtype: 'FileAttachment',
              Rect: [30, 30, 50, 50],
              FS: file(),
            }),
          ),
          context.obj({
            Type: 'Annot',
            Subtype: 'Text',
            Rect: [60, 30, 80, 50],
            Contents: PDFString.of('Visible note'),
            AF: context.register(context.obj([file()])),
          }),
        ]),
      );
    }
    const source = Buffer.from(await pdf.save({ useObjectStreams: false }));
    for (const marker of ['/EmbeddedFiles', '/AF ', '/FileAttachment', '/EF '])
      expect(source.toString('latin1')).toContain(marker);
    expect(source.includes(payloads[0]!)).toBe(true);
    const f = await t.fixture('parallel', null, source);
    const tokens = await f.tokens(await f.start());
    const preview = await t.document(tokens[0]!);
    expect(preview.statusCode).toBe(200);
    expect((await t.sign(tokens[0]!, 0)).statusCode).toBe(200);
    expect((await t.sign(tokens[1]!, 1)).statusCode).toBe(200);
    await t.settle();
    const signed = await f.signedFile();
    expect(signed.summary.status).toBe('completed');
    for (const bytes of [signed.bytes, preview.rawPayload]) {
      const cleaned = await PDFDocument.load(bytes);
      const names = cleaned.catalog.lookup(PDFName.of('Names'), PDFDict);
      expect(names.has(PDFName.of('EmbeddedFiles'))).toBe(false);
      expect(names.has(PDFName.of('Dests'))).toBe(true);
      expect(cleaned.catalog.has(PDFName.of('AF'))).toBe(false);
      for (const [index, page] of cleaned.getPages().slice(0, 2).entries()) {
        expect(page.node.has(PDFName.of('AF'))).toBe(false);
        const annotations = page.node.Annots()!.asArray();
        expect(annotations).toHaveLength(1);
        const note = cleaned.context.lookup(annotations[0], PDFDict);
        expect(note.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Text'));
        expect(note.has(PDFName.of('AF'))).toBe(false);
        expect(pageText(page)).toContain(pageText(pdf.getPage(index)));
      }
      for (const marker of ['/EmbeddedFiles', '/EmbeddedFile', '/AF ', '/FileAttachment', '/EF '])
        expect(bytes.toString('latin1')).not.toContain(marker);
      for (const payload of payloads) expect(bytes.includes(payload)).toBe(false);
      for (const [, object] of cleaned.context.enumerateIndirectObjects()) {
        if (!(object instanceof PDFRawStream)) continue;
        const decoded = Buffer.from(decodePDFRawStream(object).decode());
        for (const payload of payloads) expect(decoded.includes(payload)).toBe(false);
      }
    }
  });

  it('emails a 30-day download link when the signed PDF is too large to attach', async () => {
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    const startMail = h.sent.length;
    h.server.ctx.config.signatureAttachmentBytes = 1000;
    try {
      expect((await t.sign(tokens[0]!, 0)).statusCode).toBe(200);
      expect((await t.sign(tokens[1]!, 1)).statusCode).toBe(200);
      await t.settle();
    } finally {
      h.server.ctx.config.signatureAttachmentBytes = undefined;
    }
    const { bytes, summary } = await f.signedFile();
    const completed = h.sent
      .slice(startMail)
      .filter((mail) => mail.subject === signatureText('completed', { document: 'agreement.pdf' }));
    expect(completed).toHaveLength(3);
    for (const mail of completed) {
      expect(mail.attachments ?? []).toEqual([]);
      expect(mail.text).toContain(summary.finalHash!);
      const link = new URL(
        /https:\/\/app\.example\.test\/api\/public\/signatures\/download\?\S+/.exec(mail.text)![0],
      );
      const token = link.searchParams.get('token')!;
      expect(Number(token.split('.')[1]) - Date.now()).toBeGreaterThan(29 * 86_400_000);
      expect(mail.html).toContain(`href="${link.toString().replaceAll('&', '&amp;')}"`);
      const download = await h.server.app.inject({
        url: `${link.pathname}${link.search}`,
        remoteAddress: t.address(),
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toBe('application/pdf');
      expect(sha256(download.rawPayload)).toBe(sha256(bytes));
      const tampered = await h.server.app.inject({
        url: t.publicUrl('/download', `${token.slice(0, -2)}xx`),
        remoteAddress: t.address(),
      });
      expect(tampered.statusCode).toBe(404);
      expect(
        (await h.server.app.inject({ url: t.publicUrl('/download', tokens[0]!), remoteAddress: t.address() }))
          .statusCode,
      ).toBe(404);
    }
  });

  it('stops retrying email after 10 tries, records it, and tells the requester', async () => {
    const f = await t.fixture();
    const mailer = h.server.ctx.mailer;
    h.server.ctx.mailer = {
      async send() {
        throw new Error('Mail unavailable');
      },
    };
    let id: string;
    try {
      id = await f.start();
      for (let run = 1; run < 10; run++) {
        await query(
          h.server.pool,
          sql`UPDATE ${ident(h.server.schemas.app, 'signature_deliveries')} SET next_at = now() WHERE request_id = ${id}`,
        );
        await deliverSignatures(h.server.ctx);
      }
    } finally {
      h.server.ctx.mailer = mailer;
    }
    const deliveries = await query<{
      kind: string;
      attempts: number;
      failed_at: Date | null;
      recipient: string;
    }>(
      h.server.pool,
      sql`SELECT kind, attempts, failed_at, recipient FROM ${ident(h.server.schemas.app, 'signature_deliveries')}
      WHERE request_id = ${id!} ORDER BY id`,
    );
    expect(
      deliveries.rows.map(({ kind, attempts, failed_at }) => [kind, attempts, Boolean(failed_at)]),
    ).toEqual([
      ['invitation', 10, true],
      ['invitation', 10, true],
      ['undelivered', 0, false],
      ['undelivered', 0, false],
    ]);
    const [request] = await f.list();
    expect(request!.history.map((event) => [event.action, event.signerId])).toEqual(
      request!.signers.map((signer) => ['undelivered', signer.id]),
    );
    const startMail = h.sent.length;
    await deliverSignatures(h.server.ctx);
    expect(h.sent.slice(startMail).map((mail) => [mail.to, mail.subject])).toEqual(
      signers.map(() => [h.server.owner.email, signatureText('undelivered', { document: 'agreement.pdf' })]),
    );
  });
});

describe('the record of signing', () => {
  it('audits signer actions with no personal actor, where they came from, and the consent wording’s hash', async () => {
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    expect((await t.open(tokens[0]!)).statusCode).toBe(200);
    expect((await t.sign(tokens[0]!, 0)).statusCode).toBe(200);
    expect((await t.decline(tokens[1]!)).statusCode).toBe(200);
    const row = (await requestById(h.server.pool, h.server.schemas, id))!;
    const audit = await query<{ action: string; actor_id: string | null; metadata: Record<string, unknown> }>(
      h.server.pool,
      sql`SELECT action, actor_id, metadata FROM ${ident(h.server.schemas.audit, 'events')}
      WHERE metadata->>'requestId' = ${id} AND action IN ('signature.opened', 'signature.signed', 'signature.declined')
      ORDER BY id`,
    );
    expect(audit.rows.map((event) => event.action)).toEqual([
      'signature.opened',
      'signature.signed',
      'signature.declined',
    ]);
    for (const event of audit.rows) {
      expect(event.actor_id).toBeNull();
      expect(event.metadata).toMatchObject({ actorKind: 'signer', requestId: id, recordId: f.recordId });
      expect(typeof event.metadata.ip).toBe('string');
      expect(typeof event.metadata.userAgent).toBe('string');
    }
    expect(audit.rows[1]!.metadata).toMatchObject({
      signerId: row.signers[0]!.id,
      ip: '198.51.100.9',
      userAgent: 'Signing test browser',
      consentSha256: sha256(signatureText('consent')),
    });
    expect(audit.rows[2]!.metadata.signerId).toBe(row.signers[1]!.id);
  });

  it('stamps the date in the signer’s own zone with its abbreviation, and says UTC on the certificate', async () => {
    const f = await t.fixture();
    const id = await f.start();
    const tokens = await f.tokens(id);
    expect((await t.sign(tokens[0]!, 0, { timeZone: 'Pacific/Kiritimati' })).statusCode).toBe(200);
    expect((await t.sign(tokens[1]!, 1, { timeZone: 'Not/A_Zone' })).statusCode).toBe(200);
    await t.settle();
    const row = (await requestById(h.server.pool, h.server.schemas, id))!;
    expect(row.signers.map((signer) => signer.timeZone)).toEqual(['Pacific/Kiritimati', null]);
    const signed = await PDFDocument.load((await f.signedFile()).bytes);
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati' }).format(
      new Date(row.signers[0]!.signedAt!),
    );
    expect(pageText(signed.getPage(0))).toContain(`${local} GMT+14`);
    expect(pageText(signed.getPage(1))).toContain(`${row.signers[1]!.signedAt!.slice(0, 10)} UTC`);
    const certificate = signed.getPages().slice(2).map(pageText).join(' ');
    for (const signer of row.signers) {
      expect(certificate).toContain(certificateTime(signer.signedAt!));
      expect(certificateTime(signer.signedAt!)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
    }
    expect(certificate).toContain('Pacific/Kiritimati');
  });
});
