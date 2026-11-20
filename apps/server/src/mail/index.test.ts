import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { mailerFrom, smtpMailer } from './index.js';
import { RELAY_SIGNATURE_HEADER, RELAY_SIGNATURE_PREFIX, RELAY_TIMESTAMP_HEADER } from './relay.js';
import { sampleMessage, startStandInService, type StandInService } from './test-helpers.js';

it.each([false, true])('allows a plaintext mail catcher only with explicit opt-out: %s', async (allow) => {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.write('220 localhost ESMTP\r\n');
    let pending = '';
    let data = false;
    socket.on('data', (chunk) => {
      pending += chunk.toString();
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n');
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        commands.push(line);
        if (data) {
          if (line === '.') {
            data = false;
            socket.write('250 accepted\r\n');
          }
        } else if (line.startsWith('EHLO')) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('STARTTLS')) socket.write('502 not supported\r\n');
        else if (line.startsWith('AUTH')) socket.write('235 authenticated\r\n');
        else if (line === 'DATA') {
          data = true;
          socket.write('354 send message\r\n');
        } else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  const dir = mkdtempSync(join(tmpdir(), 'rio-smtp-'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  try {
    const config = loadConfig({
      RIOSOMA_CONFIG_DIR: dir,
      RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
      RIOSOMA_SMTP_URL: `smtp://sender:synthetic-secret@127.0.0.1:${address.port}`,
      RIOSOMA_MAIL_FROM: 'sender@example.test',
      RIOSOMA_SMTP_ALLOW_PLAINTEXT: String(allow),
    });
    const delivery = smtpMailer(config)!.send({
      to: 'recipient@example.test',
      subject: 'test',
      text: 'synthetic-sign-in-token',
      html: 'synthetic-sign-in-token',
    });
    if (allow) {
      await delivery;
      expect(commands).toContain('synthetic-sign-in-token');
    } else {
      await expect(delivery).rejects.toThrow();
      expect(commands.some((line) => /^(AUTH|MAIL|DATA)/.test(line))).toBe(false);
      expect(commands.join('\n')).not.toContain('synthetic-sign-in-token');
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('choosing the transport the settings name', () => {
  const relaySecret = ['stand-in-relay-', 'signing-secret'].join('');
  const dirs: string[] = [];
  const stands: StandInService[] = [];

  afterEach(async () => {
    while (stands.length) await stands.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function config(extra: NodeJS.ProcessEnv) {
    const dir = mkdtempSync(join(tmpdir(), 'rio-mail-transport-'));
    dirs.push(dir);
    return loadConfig({
      RIOSOMA_CONFIG_DIR: dir,
      RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
      ...extra,
    });
  }

  async function standIn(): Promise<StandInService> {
    const stand = await startStandInService();
    stands.push(stand);
    return stand;
  }

  it('stays with SMTP, and sends nothing at all without a mail server', () => {
    expect(mailerFrom(config({}))).toBeNull();
    expect(mailerFrom(config({ RIOSOMA_MAIL_TRANSPORT: 'smtp' }))).toBeNull();
    expect(
      mailerFrom(
        config({
          RIOSOMA_SMTP_URL: 'smtps://mail.example.test',
          RIOSOMA_MAIL_FROM: 'sender@example.test',
        }),
      ),
    ).not.toBeNull();
  });

  it('posts to the relay the settings name, signed', async () => {
    const stand = await standIn();
    stand.answer({ status: 202 });
    await mailerFrom(
      config({
        RIOSOMA_MAIL_TRANSPORT: 'relay',
        RIOSOMA_MAIL_FROM: 'Riosoma <sender@example.test>',
        RIOSOMA_MAIL_RELAY_URL: `${stand.url}/outbound/mail`,
        RIOSOMA_MAIL_RELAY_SECRET: relaySecret,
      }),
    )!.send(sampleMessage());

    const request = stand.requests[0]!;
    expect(request.target).toBe('/outbound/mail');
    expect(JSON.parse(request.body)).toMatchObject({
      from: 'Riosoma <sender@example.test>',
      to: 'recipient@example.test',
    });
    expect(request.headers[RELAY_SIGNATURE_HEADER]).toBe(
      `${RELAY_SIGNATURE_PREFIX}${createHmac('sha256', relaySecret)
        .update(`${request.headers[RELAY_TIMESTAMP_HEADER]}.${request.body}`, 'utf8')
        .digest('hex')}`,
    );
  });

  it('signs a send for the region’s SES endpoint', async () => {
    const stand = await standIn();
    stand.answer({ status: 200, body: { MessageId: 'message-1' } });
    await mailerFrom(
      config({
        RIOSOMA_MAIL_TRANSPORT: 'ses',
        RIOSOMA_MAIL_FROM: 'sender@example.test',
        RIOSOMA_SES_REGION: 'eu-west-1',
      }),
      {
        endpoint: stand.url,
        credentials: async () => ({
          accessKeyId: ['AKIA', 'STANDINKEY'].join(''),
          secretAccessKey: ['stand-in-ses-', 'secret'].join(''),
        }),
      },
    )!.send(sampleMessage());

    const request = stand.requests[0]!;
    expect(request.target).toBe('/v2/email/outbound-emails');
    expect(request.headers.authorization).toContain('/eu-west-1/ses/aws4_request');
    const sent = JSON.parse(request.body) as { Content: { Raw: { Data: string } } };
    expect(Buffer.from(sent.Content.Raw.Data, 'base64').toString('utf8')).toContain(
      'To: recipient@example.test',
    );
  });
});
