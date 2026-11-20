import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type * as FileSystem from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT,
  fileVault,
  keychainVault,
  loadProfile,
  removeProfile,
  type Profiles,
  type StoredProfile,
} from './credentials.js';
import { runProgram, terminalIo, type Spawn } from './io.js';
import { runCli } from './cli.js';

const observed = vi.hoisted(() => ({
  failRename: false,
  writes: [] as Array<{ fileMode: number; directoryMode: number }>,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FileSystem>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (observed.failRename) throw new Error('Replacement failed');
      return fs.renameSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      const [file] = args;
      const fileMode =
        typeof file === 'number'
          ? fs.fstatSync(file).mode
          : fs.existsSync(file)
            ? fs.statSync(file).mode
            : Number((args[2] as { mode?: number })?.mode ?? 0o666);
      const directoryMode = typeof file === 'number' ? 0o700 : fs.statSync(dirname(String(file))).mode;
      observed.writes.push({ fileMode: fileMode & 0o777, directoryMode: directoryMode & 0o777 });
      return fs.writeFileSync(...args);
    },
  };
});

const folders: string[] = [];
afterEach(() => {
  folders.splice(0).forEach((path) => fs.rmSync(path, { recursive: true, force: true }));
  observed.writes = [];
  observed.failRename = false;
});
const home = () => {
  const path = fs.mkdtempSync(join(tmpdir(), 'rio-cli-safe-'));
  folders.push(path);
  return path;
};
const profile = (): StoredProfile => ({
  url: 'https://127.0.0.1',
  kind: 'token',
  token: randomUUID(),
  savedAt: new Date().toISOString(),
});

it('creates private credential contents before replacing a loose existing file', async () => {
  const directory = home();
  fs.chmodSync(directory, 0o755);
  const path = join(directory, 'credentials.json');
  fs.writeFileSync(path, '{}', { mode: 0o644 });
  fs.chmodSync(path, 0o644);
  const inode = fs.statSync(path).ino;
  observed.writes = [];
  const stored: Profiles = { version: 1, profiles: { default: profile() } };
  await fileVault(path).write(stored);
  expect(observed.writes.length).toBeGreaterThan(0);
  for (const write of observed.writes) {
    expect(write.fileMode).toBe(0o600);
    expect(write.directoryMode).toBe(0o700);
  }
  expect(fs.statSync(path).ino).not.toBe(inode);
  expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
  expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual(stored);
  expect(fs.readdirSync(directory)).toEqual(['credentials.json']);
});

it.each(['darwin', 'linux'])(
  'sends each %s profile through stdin without putting credentials in arguments',
  async (platform) => {
    const profiles = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i), profile()]));
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const spawn: Spawn = async (_command, args, input) => {
      calls.push({ args, input });
      return {
        status: args[0] === 'find-generic-password' ? 44 : args[0] === 'lookup' ? 1 : 0,
        stdout: '',
        stderr: '',
      };
    };
    const vault = keychainVault(terminalIo({ platform, home: home(), env: {}, spawn }))!;
    await vault.write({ version: 1, profiles });
    const writes = calls.filter((call) => call.input !== undefined);
    expect(writes.length).toBeGreaterThanOrEqual(Object.keys(profiles).length);
    for (const entry of Object.values(profiles)) {
      expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(entry.token);
      expect(
        writes.some(
          (call) =>
            call.input!.includes(entry.token!) ||
            call.input!.includes(Buffer.from(JSON.stringify(entry)).toString('base64')),
        ),
      ).toBe(true);
    }
    expect(writes.every((call) => Buffer.byteLength(call.input!) < 4096)).toBe(true);
  },
);

describe('failed logout', () => {
  it.each([false, true])('reports failure and retains the credential for all=%s', async (all) => {
    const stored: Profiles = { version: 1, profiles: { default: profile() } };
    const spawn: Spawn = async (_command, args) => ({
      status: args[0] === 'find-generic-password' && args.includes(ACCOUNT) ? 0 : 1,
      stdout: args[0] === 'find-generic-password' ? JSON.stringify(stored) : '',
      stderr: '',
    });
    const output: string[] = [];
    const io = terminalIo({
      platform: 'darwin',
      home: home(),
      env: {},
      spawn,
      print: (text) => output.push(text),
      warn: (text) => output.push(text),
    });
    await expect(removeProfile(io, all ? null : 'default')).rejects.toThrow();
    expect(await loadProfile(io, 'default')).toEqual(stored.profiles.default);
    expect(await runCli(['logout', ...(all ? ['--all'] : [])], io)).toBe(1);
    expect(output.join('\n')).not.toContain('Forgot');
  });
});

it('keeps the original credentials and cleans up a failed replacement', async () => {
  const directory = home();
  const path = join(directory, 'credentials.json');
  const original: Profiles = { version: 1, profiles: { default: profile() } };
  await fileVault(path).write(original);
  observed.failRename = true;
  await expect(fileVault(path).write({ version: 1, profiles: { default: profile() } })).rejects.toThrow();
  expect(await fileVault(path).read()).toEqual(original);
  expect(fs.readdirSync(directory)).toEqual(['credentials.json']);
});

it('removes fallback credentials even when logout from the keychain fails', async () => {
  const directory = home();
  const path = join(directory, 'credentials.json');
  const original: Profiles = { version: 1, profiles: { default: profile() } };
  await fileVault(path).write(original);
  const spawn: Spawn = async (_command, args) => ({
    status: args[0] === 'find-generic-password' ? 0 : 1,
    stdout: JSON.stringify(original),
    stderr: '',
  });
  const io = terminalIo({ home: directory, env: {}, platform: 'darwin', spawn });
  await expect(removeProfile(io, null)).rejects.toThrow();
  expect(fs.existsSync(path)).toBe(false);
});

it('treats a terminated keychain process as a failure', async () => {
  const result = await runProgram(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]);
  expect(result.status).not.toBe(0);
});
