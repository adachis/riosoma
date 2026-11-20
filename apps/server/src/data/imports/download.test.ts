import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { download, DownloadError, type DownloadOptions } from './download.js';

let server: Server;
let origin: string;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/ok') return res.end(Buffer.from('hello'));
    if (path === '/hop') {
      res.writeHead(302, { location: '/ok' });
      return res.end();
    }
    if (path === '/away') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      return res.end();
    }
    if (path === '/loop') {
      res.writeHead(302, { location: '/loop' });
      return res.end();
    }
    if (path === '/declared') {
      res.writeHead(200, { 'content-length': '5000' });
      return res.end(Buffer.alloc(5000));
    }
    if (path === '/streamed') {
      // No length up front, so only counting the bytes can catch it.
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.write(Buffer.alloc(800));
      res.write(Buffer.alloc(800));
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const options: DownloadOptions = {
  // Names resolve to a private address, the way a hostile one might.
  resolve: async () => [{ address: '10.0.0.7', family: 4 }],
  // Only this test's own server may be reached on a private address.
  allowPrivate: (url) => url.hostname === '127.0.0.1' && url.port === String(port),
  maxBytes: 1_000,
};

async function read(address: string, extra: Partial<DownloadOptions> = {}): Promise<Buffer> {
  const { body } = await download(address, { ...options, ...extra });
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function problem(address: string, extra: Partial<DownloadOptions> = {}) {
  const error = await read(address, extra).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(DownloadError);
  return (error as DownloadError).problem;
}

describe('downloading from an address someone else chose', () => {
  it('fetches a file, following a redirect it checks again', async () => {
    expect((await read(`${origin}/ok`)).toString()).toBe('hello');
    expect((await read(`${origin}/hop`)).toString()).toBe('hello');
  });

  it('refuses private addresses, directly, by name, or through a redirect', async () => {
    expect(await problem('http://169.254.169.254/latest/meta-data')).toBe('blocked');
    expect(await problem('http://files.internal.test/secret.txt')).toBe('blocked');
    expect(await problem(`${origin}/away`)).toBe('blocked');
    expect(await problem(`http://127.0.0.1:${port + 1}/ok`)).toBe('blocked');
  });

  it('refuses addresses with credentials and schemes other than http and https', async () => {
    expect(await problem(`http://someone:secret@127.0.0.1:${port}/ok`)).toBe('blocked');
    expect(await problem('ftp://example.com/file')).toBe('blocked');
    expect(await problem('file:///etc/passwd')).toBe('blocked');
  });

  it('refuses files past the limit, whether their size is said up front or not', async () => {
    expect(await problem(`${origin}/declared`)).toBe('tooLarge');
    expect(await problem(`${origin}/streamed`)).toBe('tooLarge');
    expect((await read(`${origin}/streamed`, { maxBytes: 2_000 })).length).toBe(1_600);
  });

  it('gives up on missing files and endless redirects', async () => {
    expect(await problem(`${origin}/missing`)).toBe('failed');
    expect(await problem(`${origin}/loop`)).toBe('failed');
    expect(await problem('not an address')).toBe('failed');
  });
});
