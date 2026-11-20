import { describe, expect, it } from 'vitest';
import { reportEmail, type ReportEmailInput } from './email.js';
import { formatMessage } from './messages.js';
import { checkUnsubscribeToken, unsubscribeToken } from './unsubscribe.js';
import { type ReportLayout } from './layout.js';
import { fallbackReportPdf } from './pdf.js';
import { readReportPdf } from './pdf.test-support.js';

const email = (overrides: Partial<ReportEmailInput> = {}) =>
  reportEmail({
    to: 'reader@example.test',
    locale: 'en-US',
    timeZone: 'America/Denver',
    reportName: 'Open deals',
    viewName: 'Grid',
    tableName: 'Deals',
    ownerName: 'Ada',
    sentAt: new Date('2026-10-05T15:00:00Z'),
    format: 'csv',
    count: 1,
    columns: ['Name'],
    rows: [['Acme']],
    attachment: null,
    tooLarge: false,
    viewLink: 'https://riosoma.example.test/db/tbl/viw',
    stopLink: 'https://riosoma.example.test/reports/unsubscribe?token=a.b',
    oneClickLink: 'https://riosoma.example.test/api/reports/unsubscribe?token=a.b',
    ...overrides,
  });

describe('the report email', () => {
  it('abbreviates PDF summary headers and cells while retaining full attachment text and fills', async () => {
    const value = 'x'.repeat(10_000);
    const heading = 'h'.repeat(150);
    const layout: ReportLayout = {
      title: 'Open deals',
      subtitle: 'Deals',
      locale: 'en-US',
      count: 1,
      columns: [{ text: heading }],
      rows: [
        { kind: 'group', cells: [{ text: value }] },
        { kind: 'record', cells: [{ text: value, fill: '#DDEFE1' }] },
        { kind: 'total', cells: [{ text: value }] },
      ],
      charts: [],
      landscape: false,
      notes: [],
    };
    const bytes = await fallbackReportPdf(layout, {});
    const message = email({
      format: 'pdf',
      columns: [heading],
      rows: [[value]],
      layout,
      attachment: { content: bytes, filename: 'report.pdf', contentType: 'application/pdf' },
    });
    expect(message.html).not.toContain('x'.repeat(120));
    expect(message.html).not.toContain('h'.repeat(120));
    expect(message.html).toContain(`${'x'.repeat(119)}…`);
    expect(message.html).toContain(`${'h'.repeat(119)}…`);
    expect(message.html).toContain('background-color:#DDEFE1');
    expect(message.text).toContain(`${'x'.repeat(119)}…`);
    const pages = await readReportPdf(message.attachments![0]!.content);
    expect(pages.length).toBeGreaterThan(1);
    expect(
      pages
        .map((page) => page.text)
        .join('')
        .match(/x/g),
    ).toHaveLength(3 * value.length);
    expect(layout.rows[1]!.cells[0]!.text).toBe(value);
  });

  it('counts records the way the reader’s language does', () => {
    const count = '{count, plural, =0 {None.} one {# record.} other {# records.}}';
    expect(formatMessage(count, { count: 0 }, { locale: 'en-US', html: false })).toBe('None.');
    expect(formatMessage(count, { count: 1 }, { locale: 'en-US', html: false })).toBe('1 record.');
    expect(formatMessage(count, { count: 12_345 }, { locale: 'de', html: false })).toBe('12.345 records.');
    expect(email({ count: 0, rows: [] }).text).toContain('No records are in the view right now.');
    expect(email({ count: 1 }).text).toContain('1 record is in the view.');
  });

  it('escapes what records hold and never reads it as markup', () => {
    const message = email({
      reportName: 'Q3 <b>deals</b>',
      columns: ['Name & title'],
      rows: [['<img src=x onerror=alert(1)>']],
    });
    expect(message.html).not.toContain('<img');
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(message.html).toContain('<th align="left">Name &amp; title</th>');
    expect(message.html).toContain('Q3 &lt;b&gt;deals&lt;/b&gt;');
    expect(message.text).toContain('<img src=x onerror=alert(1)>');
  });

  it('keeps the subject to one short line', () => {
    const message = email({ reportName: `Weekly\nreport ${'x'.repeat(80)}`, viewName: 'Grid' });
    expect(message.subject).not.toMatch(/\n/);
    expect(message.subject.endsWith('…: Grid')).toBe(true);
  });

  it('names the schedule and who set it up, and links to stop receiving it', () => {
    const message = email();
    expect(message.text).toContain('You’re getting this because Ada set up the scheduled report Open deals.');
    expect(message.text).toContain(
      'Stop receiving it: https://riosoma.example.test/reports/unsubscribe?token=a.b',
    );
    expect(message.html).toContain(
      '<a href="https://riosoma.example.test/reports/unsubscribe?token=a.b">https://riosoma.example.test/reports/unsubscribe?token=a.b</a>',
    );
  });
});

describe('the link to stop receiving a report', () => {
  const secret = Buffer.alloc(32, 3);
  const now = new Date('2026-10-05T15:00:00Z');

  it('names the report and recipient it was made for', () => {
    const member = unsubscribeToken(
      secret,
      'rptAAAAAAAAAAAAAA',
      { kind: 'member', userId: 'usrBBBBBBBBBBBBBB' },
      now,
    );
    expect(checkUnsubscribeToken(secret, member, now)).toEqual({
      ok: true,
      reportId: 'rptAAAAAAAAAAAAAA',
      recipient: { kind: 'member', userId: 'usrBBBBBBBBBBBBBB' },
    });
    const outside = unsubscribeToken(
      secret,
      'rptAAAAAAAAAAAAAA',
      { kind: 'address', address: 'a@b.example' },
      now,
    );
    // The address itself never travels in the link.
    expect(Buffer.from(outside.split('.')[0]!, 'base64url').toString()).not.toContain('a@b.example');
    expect(checkUnsubscribeToken(secret, outside, now)).toMatchObject({
      ok: true,
      recipient: { kind: 'address' },
    });
  });

  it('stops working after 90 days', () => {
    const token = unsubscribeToken(
      secret,
      'rptAAAAAAAAAAAAAA',
      { kind: 'member', userId: 'usrBBBBBBBBBBBBBB' },
      now,
    );
    const later = (days: number) => new Date(now.getTime() + days * 86_400_000);
    expect(checkUnsubscribeToken(secret, token, later(89)).ok).toBe(true);
    expect(checkUnsubscribeToken(secret, token, later(90))).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses one that was changed or signed with another key', () => {
    const token = unsubscribeToken(
      secret,
      'rptAAAAAAAAAAAAAA',
      { kind: 'member', userId: 'usrBBBBBBBBBBBBBB' },
      now,
    );
    const [payload, signature] = token.split('.') as [string, string];
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
    const longer = Buffer.from(JSON.stringify({ ...claim, e: Number(claim.e) + 86_400 })).toString(
      'base64url',
    );
    for (const changed of [
      `${longer}.${signature}`,
      `${payload}.${signature.slice(1)}`,
      `${payload}`,
      '',
      unsubscribeToken(
        Buffer.alloc(32, 4),
        'rptAAAAAAAAAAAAAA',
        { kind: 'member', userId: 'usrBBBBBBBBBBBBBB' },
        now,
      ),
    ])
      expect(checkUnsubscribeToken(secret, changed, now)).toEqual({ ok: false, reason: 'invalid' });
  });
});
