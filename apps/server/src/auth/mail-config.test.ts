import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { smtpMailer } from '../mail/index.js';
import { signInMessage } from '../mail/messages.js';

const sendMail = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));
const dirs: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function config(env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rio-mail-'));
  dirs.push(dir);
  return loadConfig({
    RIOSOMA_CONFIG_DIR: dir,
    RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
    ...env,
  });
}

describe('authentication configuration', () => {
  it('defaults session lifetimes and accepts configured day counts', () => {
    expect(config()).toMatchObject({ sessionIdleDays: 7, sessionMaxDays: 30 });
    expect(config({ RIOSOMA_SESSION_IDLE_DAYS: '2', RIOSOMA_SESSION_MAX_DAYS: '14' })).toMatchObject({
      sessionIdleDays: 2,
      sessionMaxDays: 14,
    });
    for (const value of ['0', '-1', 'invalid']) {
      expect(() => config({ RIOSOMA_SESSION_IDLE_DAYS: value })).toThrow();
      expect(() => config({ RIOSOMA_SESSION_MAX_DAYS: value })).toThrow();
    }
  });

  it('requires an SMTP URL and a sender before enabling email', () => {
    expect(smtpMailer(config())).toBeNull();
    expect(smtpMailer(config({ RIOSOMA_SMTP_URL: 'smtp://mail.example.test' }))).toBeNull();
    expect(smtpMailer(config({ RIOSOMA_MAIL_FROM: 'Riosoma <mail@example.test>' }))).toBeNull();
    expect(() => config({ RIOSOMA_SMTP_URL: 'https://mail.example.test' })).toThrow();
    expect(() => config({ RIOSOMA_MAIL_FROM: 'mail@example.test\r\nBcc: other@example.test' })).toThrow();
  });

  it.each([
    ['smtp://sender:p%40ss@mail.example.test:2525', 2525, false],
    ['smtps://sender:p%40ss@mail.example.test', 465, true],
  ])('configures delivery from %s without protocol logging', async (url, port, secure) => {
    const mailer = smtpMailer(config({ RIOSOMA_SMTP_URL: url, RIOSOMA_MAIL_FROM: 'mail@example.test' }));
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      {
        host: 'mail.example.test',
        port,
        secure,
        requireTLS: !secure,
        tls: { rejectUnauthorized: true },
        auth: { user: 'sender', pass: 'p@ss' },
        logger: false,
        debug: false,
      },
      { from: 'mail@example.test', disableFileAccess: true, disableUrlAccess: true },
    );
    const message = signInMessage(
      'person@example.test',
      'en-US',
      'https://example.test/sign-in/link#token=test',
    );
    await mailer!.send(message);
    expect(sendMail).toHaveBeenCalledWith(message);
  });

  it('falls back to American English and escapes links in HTML', () => {
    const link = 'https://example.test/sign-in/link#token=test&value="<test>"';
    const message = signInMessage('person@example.test', 'unsupported', link);
    for (const locale of ['en-US', '__proto__', 'constructor', 'toString']) {
      expect(message).toEqual(signInMessage('person@example.test', locale, link));
    }
    expect(message.text).toContain(link);
    expect(message.html).toContain('&amp;value=&quot;&lt;test&gt;&quot;');
    expect(message.html).not.toContain('<test>');
  });
});
