import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Messages from './messages.js';
import { runCli } from './cli.js';
import { terminalIo } from './io.js';

vi.mock('./messages.js', async (original) => {
  const actual = await original<typeof Messages>();
  return {
    ...actual,
    message: (...args: Parameters<typeof actual.message>) => `⟦${actual.message(...args)}⟧`,
  };
});

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

it.each([['help', 'export'], ['missing-command'], ['logout'], ['records', '--missing']])(
  'renders help, status, and errors through message keys: %j',
  async (...args) => {
    const home = mkdtempSync(join(tmpdir(), 'rio-cli-messages-'));
    folders.push(home);
    const output: string[] = [];
    const io = terminalIo({
      home,
      env: { RIOSOMA_KEYCHAIN: 'off' },
      print: (text) => output.push(text),
      warn: (text) => output.push(text),
    });
    await runCli(args, io);
    expect(output[0]).toContain('⟦');
    if (args[0] === 'help') {
      expect(output).toContain('⟦Options:⟧');
      expect(output.join('\n')).toContain('⟦Where to write, or - for standard output⟧');
    }
  },
);

it('renders the callback page through message keys', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rio-cli-page-'));
  folders.push(home);
  const baseUrl = 'https://127.0.0.1';
  let page = '';
  const io = terminalIo({
    home,
    env: { RIOSOMA_KEYCHAIN: 'off' },
    print: () => undefined,
    warn: () => undefined,
    fetch: async () =>
      new Response(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/oauth/authorize`,
          token_endpoint: `${baseUrl}/oauth/token`,
        }),
      ),
    open: async (address) => {
      const request = new URL(address);
      const callback = new URL(request.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', request.searchParams.get('state')!);
      callback.searchParams.set('error', 'access_denied');
      page = await (await fetch(callback)).text();
      return true;
    },
  });
  expect(
    await runCli(['login', '--browser', '--url', baseUrl, '--client-id', globalThis.crypto.randomUUID()], io),
  ).toBe(1);
  expect(page).toContain('⟦You can close this tab.⟧');
  expect(page).toContain('⟦The command line has what it needs.  Nothing else is sent from here.⟧');
  expect(page).toContain('lang="en"');
});
