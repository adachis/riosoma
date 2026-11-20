import { expect } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  type PDFPage,
} from 'pdf-lib';
import sharp from 'sharp';
import {
  newId,
  type AttachmentMeta,
  type CommandBatchResult,
  type RowData,
  type SignatureRequestInput,
  type SignatureRequestSummary,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { MailMessage } from '../mail/index.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { signatureText } from './pdf.js';
import { requestById } from './store.js';
import { signingToken } from './token.js';
import { signaturesSettled } from './worker.js';

export const DAY = 86_400_000;
export const signers = [
  { name: 'Jamie Park', email: 'jamie@example.test' },
  { name: 'Morgan Lee', email: 'morgan@example.test' },
];

export interface Harness {
  kit: TestPostgres;
  server: ServerFixture;
  sent: MailMessage[];
  original: Buffer;
  signature: string;
}

/** A server whose mail lands in `sent`, a two-page agreement, and a signature image. */
export async function harness(prefix: string): Promise<Harness> {
  const kit = await startTestPostgres();
  // The file makes more requests than a person may in an hour, so the limits are raised here and
  // lowered only in the test for them.
  const server = await startServer(kit, prefix, {
    baseUrl: 'https://app.example.test',
    signatureRequestHourlyLimit: 10_000,
    signatureSignerDailyLimit: 100_000,
  });
  const sent: MailMessage[] = [];
  server.ctx.mailer = {
    async send(message) {
      sent.push(message);
    },
  };
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of ['Original agreement, page one', 'Original agreement, page two'])
    pdf.addPage([612, 792]).drawText(text, { x: 30, y: 740, font, size: 14 });
  const original = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const signature = `data:image/png;base64,${(
    await sharp({
      create: { width: 120, height: 40, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } },
    })
      .png()
      .toBuffer()
  ).toString('base64')}`;
  return { kit, server, sent, original, signature };
}

export function helpers(h: Harness) {
  const { server } = h;
  let addresses = 0;
  /** A fresh address per public call, so the per-address limit never trips a test by accident. */
  const address = () => {
    addresses += 1;
    return `10.${(addresses >> 16) & 255}.${(addresses >> 8) & 255}.${addresses & 255}`;
  };

  async function command(databaseId: string, input: Record<string, unknown>, who: SignedIn = server.owner) {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: who.headers,
      payload: {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
  }

  async function grant(databaseId: string, userId: string, role: string) {
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${userId}, ${role})`,
    );
  }

  async function fixture(
    order: 'parallel' | 'sequential' = 'parallel',
    dueAt: string | null = null,
    pdf: Buffer = h.original,
  ) {
    const databaseId = newId('database');
    const tableId = newId('table');
    const recordId = newId('record');
    const fields = {
      name: newId('field'),
      file: newId('field'),
      status: newId('field'),
      date: newId('field'),
    };
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: {
        id: databaseId,
        name: 'Agreements',
        table: {
          id: tableId,
          name: 'Agreements',
          fields: [
            { id: fields.name, name: 'Name', type: 'text' },
            { id: fields.file, name: 'Files', type: 'attachment' },
            { id: fields.status, name: 'Status', type: 'text' },
            { id: fields.date, name: 'Completed', type: 'date', options: { includeTime: true } },
          ],
          view: { id: newId('view'), name: 'Grid' },
          records: [],
        },
      },
    });
    expect(create.statusCode, create.body).toBe(200);
    const upload = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${tableId}/fields/${fields.file}/files`,
      headers: { ...server.owner.headers, 'content-type': 'application/pdf', 'x-file-name': 'agreement.pdf' },
      payload: pdf,
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const file = upload.json<AttachmentMeta>();
    await command(databaseId, {
      kind: 'record.create',
      tableId,
      records: [{ id: recordId, values: { [fields.name]: 'Agreement', [fields.file]: [file.id] } }],
    });
    const input: SignatureRequestInput = {
      attachmentId: file.id,
      signers,
      order,
      dueAt,
      message: 'Please review the agreement.',
      statusFieldId: fields.status,
      statusValue: 'Completed',
      dateFieldId: fields.date,
      fields: signers.flatMap((_, signer) =>
        (['signature', 'initials', 'name', 'date', 'text'] as const).map((kind, index) => ({
          id: `field-${signer}-${kind}`,
          kind,
          signer,
          page: signer,
          x: 0.1,
          y: 0.1 + index * 0.1,
          width: 0.5,
          height: 0.06,
        })),
      ),
    };
    const url = `/api/tables/${tableId}/records/${recordId}/signature-requests`;
    async function request(who: SignedIn = server.owner, changes: Partial<SignatureRequestInput> = {}) {
      return server.app.inject({
        method: 'POST',
        url,
        headers: who.headers,
        payload: { ...input, ...changes },
      });
    }
    async function start(who: SignedIn = server.owner) {
      const response = await request(who);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ id: string }>().id;
    }
    async function list(who: SignedIn = server.owner) {
      const response = await server.app.inject({ url, headers: who.headers });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ requests: SignatureRequestSummary[] }>().requests;
    }
    async function tokens(id: string) {
      const row = (await requestById(server.pool, server.schemas, id))!;
      return row.signers.map((signer) =>
        signingToken(server.ctx.config.secretKey, id, signer.id, row.expires_at),
      );
    }
    async function record() {
      const response = await server.app.inject({
        url: `/api/tables/${tableId}/records/${recordId}`,
        headers: server.owner.headers,
      });
      return response.json<RowData & { attachments: Record<string, AttachmentMeta> }>();
    }
    /** The signed PDF's bytes, downloaded as the owner. */
    async function signedFile() {
      const [summary] = await list();
      const data = await record();
      const attachment = data.attachments[summary!.signedAttachmentId!]!;
      const download = await server.app.inject({ url: attachment.url, headers: server.owner.headers });
      expect(download.statusCode, download.body.slice(0, 100)).toBe(200);
      return { summary: summary!, attachment, bytes: download.rawPayload, record: data };
    }
    return {
      databaseId,
      tableId,
      recordId,
      fields,
      file,
      input,
      url,
      request,
      start,
      list,
      tokens,
      record,
      signedFile,
    };
  }

  function publicUrl(path: string, token: string) {
    return `/api/public/signatures${path}?${new URLSearchParams({ token })}`;
  }
  async function open(token: string) {
    return server.app.inject({ url: publicUrl('', token), remoteAddress: address() });
  }
  async function document(token: string) {
    return server.app.inject({ url: publicUrl('/document', token), remoteAddress: address() });
  }
  async function decline(token: string, reason = 'The dates need updating.') {
    return server.app.inject({
      method: 'POST',
      url: publicUrl('/decline', token),
      remoteAddress: address(),
      payload: { reason },
    });
  }
  async function sign(
    token: string,
    index: number,
    overrides: Record<string, unknown> = {},
    headers: Record<string, string> = { 'user-agent': 'Signing test browser' },
  ) {
    return server.app.inject({
      method: 'POST',
      url: publicUrl('/sign', token),
      headers,
      remoteAddress: '198.51.100.9',
      payload: {
        consent: true,
        consentText: signatureText('consent'),
        values: {
          [`field-${index}-signature`]: { image: h.signature },
          [`field-${index}-initials`]: { image: h.signature },
          [`field-${index}-text`]: { text: `Approved by signer ${index + 1}` },
        },
        ...overrides,
      },
    });
  }
  /** Waits for the background worker to attach signed PDFs and send what's waiting. */
  const settle = () => signaturesSettled(server.ctx);
  const resetLimits = () =>
    query(server.pool, sql`DELETE FROM ${ident(server.schemas.app, 'signature_attempts')}`);
  return { address, command, grant, fixture, open, document, decline, sign, settle, resetLimits, publicUrl };
}

export function streams(page: PDFPage): string[] {
  const contents = page.node.Contents();
  const values = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return values
    .map((value) => page.doc.context.lookup(value))
    .filter((value): value is PDFRawStream => value instanceof PDFRawStream)
    .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'));
}

// The standard fonts' encoding differs from Latin-1 only in these places.
const WIN_ANSI: Record<number, string> = {
  0x80: '€',
  0x85: '…',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
};

function winAnsi(hex: string): string {
  return Array.from(Buffer.from(hex, 'hex'), (code) => WIN_ANSI[code] ?? String.fromCharCode(code)).join('');
}

/** Every text-showing operation on a page, with where its line starts. */
export function textRuns(page: PDFPage): Array<{ x: number; y: number; text: string }> {
  return streams(page).flatMap((stream) =>
    [...stream.matchAll(/(-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)>\s*Tj/g)].map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
      text: winAnsi(match[3]!),
    })),
  );
}

export function pageText(page: PDFPage): string {
  return textRuns(page)
    .map((run) => run.text)
    .join(' ');
}

/** The clipping rectangles a page sets, as [x, y, width, height]. */
export function clips(page: PDFPage): number[][] {
  return streams(page).flatMap((stream) =>
    [...stream.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\s+W\s+n/g)].map((match) =>
      match.slice(1, 5).map(Number),
    ),
  );
}

/** The form XObjects a page draws, decoded. */
export function pageForms(page: PDFPage): Array<{ name: string; content: string }> {
  const resources = page.node.Resources();
  const objects = resources?.lookup(PDFName.of('XObject'));
  if (!(objects instanceof PDFDict)) return [];
  return objects.entries().flatMap(([name, ref]) => {
    const stream = page.doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream) || stream.dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Form'))
      return [];
    return [
      {
        name: name.decodeText(),
        content: Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'),
      },
    ];
  });
}

export function near(actual: number, expected: number) {
  return Math.abs(actual - expected) < 0.01;
}
