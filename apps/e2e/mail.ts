import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';

/**
 * A mail catcher for browser tests: a small SMTP server on this machine that takes every message
 * the test server sends and keeps it as a file, and a reader that turns those files back into
 * subjects, text, HTML, and attachments.  Nothing leaves the machine.
 *
 * The catcher runs where the stack starts, and the tests read its folder, so each browser's
 * server has a mailbox of its own.
 */

export interface MailCatcher {
  /** The address the test server sends through */
  url: string;
  /** Where each message lands, one file apiece */
  dir: string;
  stop(): Promise<void>;
}

export async function startMailCatcher(dir: string): Promise<MailCatcher> {
  mkdirSync(dir, { recursive: true });
  let count = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffered = '';
    let reading = false;
    let lines: string[] = [];
    let to: string[] = [];
    const reply = (text: string) => socket.write(`${text}\r\n`);
    const line = (text: string) => {
      if (reading) {
        if (text !== '.') {
          // A leading dot is doubled on the wire so a lone one can end the message.
          lines.push(text.startsWith('..') ? text.slice(1) : text);
          return;
        }
        reading = false;
        count += 1;
        const name = `${String(Date.now()).padStart(15, '0')}-${String(count).padStart(5, '0')}.json`;
        // Written aside and then moved, so a test never reads half a message.
        writeFileSync(join(dir, `${name}.part`), JSON.stringify({ to, raw: lines.join('\r\n') }));
        renameSync(join(dir, `${name}.part`), join(dir, name));
        lines = [];
        to = [];
        reply('250 Kept');
        return;
      }
      const command = text.slice(0, 4).toUpperCase();
      if (command === 'EHLO') reply('250-catcher\r\n250-8BITMIME\r\n250 SMTPUTF8');
      else if (command === 'HELO') reply('250 catcher');
      else if (command === 'MAIL') {
        to = [];
        reply('250 OK');
      } else if (command === 'RCPT') {
        const address = /<([^>]*)>/.exec(text)?.[1];
        if (address) to.push(address.toLowerCase());
        reply('250 OK');
      } else if (command === 'DATA') {
        reading = true;
        lines = [];
        reply('354 Go ahead');
      } else if (command === 'RSET') {
        to = [];
        reply('250 OK');
      } else if (command === 'NOOP') reply('250 OK');
      else if (command === 'QUIT') {
        reply('221 Bye');
        socket.end();
      } else reply('502 Not here');
    };
    // Decoded as a stream, so a character split between two packets comes through whole.
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let end = buffered.indexOf('\r\n');
      while (end >= 0) {
        line(buffered.slice(0, end));
        buffered = buffered.slice(end + 2);
        end = buffered.indexOf('\r\n');
      }
    });
    reply('220 catcher ESMTP');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `smtp://127.0.0.1:${port}`,
    dir,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(done));
    },
  };
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface Mail {
  /** Who the message went to, as the server addressed it */
  to: string[];
  subject: string;
  text: string;
  html: string;
  attachments: MailAttachment[];
  headers: Map<string, string>;
}

interface Part {
  headers: Map<string, string>;
  body: string;
}

function split(raw: string): Part {
  const end = raw.search(/\r?\n\r?\n/);
  const head = end < 0 ? raw : raw.slice(0, end);
  const body = end < 0 ? '' : raw.slice(end).replace(/^\r?\n\r?\n/, '');
  const headers = new Map<string, string>();
  // A header continues on lines that start with a space or a tab.
  for (const field of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = field.indexOf(':');
    if (colon > 0) headers.set(field.slice(0, colon).trim().toLowerCase(), field.slice(colon + 1).trim());
  }
  return { headers, body };
}

function parameter(header: string, name: string): string | null {
  const match = new RegExp(`${name}\\*?=("([^"]*)"|[^;\\s]+)`, 'i').exec(header);
  if (!match) return null;
  const value = match[2] ?? match[1]!;
  // A long or non-ASCII name comes as charset''percent-encoding.
  return /^utf-8''/i.test(value) ? decodeURIComponent(value.replace(/^utf-8''/i, '')) : value;
}

function quotedPrintable(text: string): Buffer {
  const soft = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < soft.length; index += 1) {
    const hex = soft.slice(index + 1, index + 3);
    if (soft[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
    } else bytes.push(...Buffer.from(soft[index]!, 'utf8'));
  }
  return Buffer.from(bytes);
}

function decode(part: Part): Buffer {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '7bit').toLowerCase();
  if (encoding === 'base64') return Buffer.from(part.body.replace(/\s+/g, ''), 'base64');
  if (encoding === 'quoted-printable') return quotedPrintable(part.body);
  return Buffer.from(part.body, 'utf8');
}

/** Encoded words in a header, such as a subject with a curly quote in it. */
function words(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, _charset: string, kind: string, text: string) =>
      kind.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64').toString('utf8')
        : quotedPrintable(text.replace(/_/g, ' ')).toString('utf8'),
    );
}

function walk(part: Part, mail: Mail): void {
  const type = part.headers.get('content-type') ?? 'text/plain';
  const boundary = parameter(type, 'boundary');
  if (/^multipart\//i.test(type) && boundary) {
    const pieces = part.body.split(`--${boundary}`).slice(1);
    for (const piece of pieces) {
      if (piece.startsWith('--')) break;
      walk(split(piece.replace(/^\r?\n/, '')), mail);
    }
    return;
  }
  const disposition = part.headers.get('content-disposition') ?? '';
  const filename = parameter(disposition, 'filename') ?? parameter(type, 'name');
  const content = decode(part);
  if (filename || /^attachment/i.test(disposition)) {
    mail.attachments.push({
      filename: filename ? words(filename) : '',
      contentType: type.split(';')[0]!.trim().toLowerCase(),
      content,
    });
  } else if (/^text\/html/i.test(type)) mail.html += content.toString('utf8');
  else if (/^text\//i.test(type)) mail.text += content.toString('utf8');
}

/** Every message a mailbox holds, oldest first. */
export function readMailbox(dir: string): Mail[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    const { to, raw } = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { to: string[]; raw: string };
    const top = split(raw);
    const mail: Mail = {
      to,
      subject: words(top.headers.get('subject') ?? ''),
      text: '',
      html: '',
      attachments: [],
      headers: top.headers,
    };
    walk(top, mail);
    return mail;
  });
}
