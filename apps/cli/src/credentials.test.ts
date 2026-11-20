import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT,
  SERVICE,
  fileVault,
  keychainVault,
  loadProfile,
  privateEnough,
  profileName,
  removeProfile,
  saveProfile,
  vaultsFor,
  type StoredProfile,
} from './credentials.js';
import { terminalIo, type Io, type Spawn } from './io.js';

/**
 * Where a credential is kept.  A token is a way into someone's account, so these check the two
 * things that matter: that it goes into the operating system's keychain when this machine has one,
 * and that the file it falls back to can only be read by the person who wrote it.  The keychain is
 * stood in for by a program that remembers what it was given, so no test touches a real one.
 */

let home: string;
let folders: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rio-cli-credentials-'));
  folders.push(home);
});

afterEach(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  folders = [];
});

/** A stand-in for `security` or `secret-tool`, which keeps one item and records what it was asked. */
function standIn(options: { installed?: boolean } = {}) {
  const installed = options.installed ?? true;
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  const held = new Map<string, string>();
  const spawn: Spawn = async (command, args, input) => {
    calls.push({ command, args: [...args], ...(input === undefined ? {} : { input }) });
    if (!installed) return { status: 127, stdout: '', stderr: 'not installed' };
    const words = args[0] === '-i' ? input!.trim().split(' ') : [...args];
    const account = words[words.indexOf(command === 'security' ? '-a' : 'account') + 1]!;
    const what = words[0];
    if (what === 'find-generic-password' || what === 'lookup')
      return !held.has(account)
        ? { status: command === 'security' ? 44 : 1, stdout: '', stderr: 'could not be found' }
        : { status: 0, stdout: `${held.get(account)}\n`, stderr: '' };
    if (what === 'add-generic-password') {
      held.set(account, words[words.length - 1]!);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (what === 'store') {
      held.set(account, input!);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (what === 'delete-generic-password' || what === 'clear') {
      held.delete(account);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `nothing here does ${what}` };
  };
  return {
    spawn,
    calls,
    held: () =>
      held.size
        ? [...held.values()]
            .map((value) => (value.startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8')))
            .join('\n')
        : null,
    put: (value: string) => void held.set(ACCOUNT, value),
  };
}

function ioFor(options: {
  platform?: string;
  spawn?: Spawn;
  env?: Record<string, string | undefined>;
  home?: string;
}): Io {
  const out: string[] = [];
  return terminalIo({
    env: { RIOSOMA_KEYCHAIN: undefined, ...(options.env ?? {}) } as NodeJS.ProcessEnv,
    home: options.home ?? home,
    platform: options.platform ?? 'linux',
    print: (text) => out.push(text),
    warn: (text) => out.push(text),
    ...(options.spawn ? { spawn: options.spawn } : {}),
  });
}

const profile = (token: string): StoredProfile => ({
  url: 'https://riosoma.example.com',
  kind: 'token',
  token,
  savedAt: new Date().toISOString(),
});

describe('a keychain', () => {
  it('keeps the credential, and leaves no file behind', async () => {
    const stand = standIn();
    const io = ioFor({ platform: 'darwin', spawn: stand.spawn });
    const where = await saveProfile(io, 'default', profile('rio_pat_stored_in_the_keychain'));
    expect(where.where).toBe('the macOS keychain');
    expect(stand.held()).toContain('rio_pat_stored_in_the_keychain');
    expect(vaultsFor(io)[1]!.where).toContain('credentials.json');
    await expect(fileVault(vaultsFor(io)[1]!.where).read()).resolves.toBeNull();

    const read = await loadProfile(io, 'default');
    expect(read?.token).toBe('rio_pat_stored_in_the_keychain');
    const write = stand.calls.find((call) => call.input?.includes(`-a ${ACCOUNT} `))!;
    expect(write.input).toContain(SERVICE);
    expect(write.input).toContain(ACCOUNT);
    expect(write.args).toEqual(['-i']);
  });

  it('gives a Linux keyring the secret on its standard input, not in its arguments', async () => {
    const stand = standIn();
    const io = ioFor({ platform: 'linux', spawn: stand.spawn });
    await saveProfile(io, 'default', profile('rio_pat_on_standard_input'));
    const write = stand.calls.find((call) => call.args[0] === 'store')!;
    expect(write.input).toContain('rio_pat_on_standard_input');
    expect(write.args.join(' ')).not.toContain('rio_pat_on_standard_input');
    expect((await loadProfile(io, 'default'))?.token).toBe('rio_pat_on_standard_input');
  });

  it('falls back to a file when this machine has no keychain program', async () => {
    const stand = standIn({ installed: false });
    const io = ioFor({ platform: 'darwin', spawn: stand.spawn });
    const where = await saveProfile(io, 'default', profile('rio_pat_in_a_file'));
    expect(where.where).toContain('credentials.json');
    const path = join(home, 'credentials.json');
    expect((await loadProfile(io, 'default'))?.token).toBe('rio_pat_in_a_file');
    // Only the person who wrote it may read it, and only they may look in the folder.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(privateEnough(path)).toBe(true);
  });

  it('finds a credential in the file when the keychain holds nothing', async () => {
    const stand = standIn();
    const io = ioFor({ platform: 'darwin', spawn: stand.spawn });
    await fileVault(join(home, 'credentials.json')).write({
      version: 1,
      profiles: { default: profile('rio_pat_from_the_file') },
    });
    expect((await loadProfile(io, 'default'))?.token).toBe('rio_pat_from_the_file');
  });

  it('keeps a file private when one is written over', async () => {
    const path = join(home, 'credentials.json');
    writeFileSync(path, '{}', { mode: 0o644 });
    chmodWide(path);
    await fileVault(path).write({ version: 1, profiles: { default: profile('rio_pat_rewritten') } });
    expect(privateEnough(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).profiles.default.token).toBe('rio_pat_rewritten');
  });

  it('does as it’s told when a keychain is turned off', async () => {
    const stand = standIn();
    const io = ioFor({ platform: 'darwin', spawn: stand.spawn, env: { RIOSOMA_KEYCHAIN: 'off' } });
    expect(vaultsFor(io)).toHaveLength(1);
    expect(keychainVault(io)).not.toBeNull();
    const where = await saveProfile(io, 'default', profile('rio_pat_not_in_the_keychain'));
    expect(where.where).toContain('credentials.json');
    expect(stand.held()).toBeNull();
  });

  it('has no keychain to use on a platform with none', () => {
    expect(keychainVault(ioFor({ platform: 'win32', spawn: standIn().spawn }))).toBeNull();
    expect(vaultsFor(ioFor({ platform: 'win32', spawn: standIn().spawn }))).toHaveLength(1);
  });
});

describe('profiles', () => {
  it.each(['darwin', 'linux'])(
    'migrates older %s entries and removes one profile without losing another',
    async (platform) => {
      const stand = standIn();
      const io = ioFor({ platform, spawn: stand.spawn });
      const work = profile(globalThis.crypto.randomUUID());
      const personal = profile(globalThis.crypto.randomUUID());
      stand.put(JSON.stringify({ version: 1, profiles: { work } }));
      await saveProfile(io, 'personal', personal);
      expect(await loadProfile(io, 'work')).toEqual(work);
      expect(await loadProfile(io, 'personal')).toEqual(personal);
      expect(await removeProfile(io, 'work')).toBe(true);
      expect(await loadProfile(io, 'work')).toBeNull();
      expect(await loadProfile(io, 'personal')).toEqual(personal);
      expect(await removeProfile(io, null)).toBe(true);
      expect(stand.held()).toBeNull();
    },
  );

  it('falls back privately before writing an oversized macOS entry', async () => {
    const stand = standIn();
    const io = ioFor({ platform: 'darwin', spawn: stand.spawn });
    const stored = profile(globalThis.crypto.randomUUID().repeat(150));
    const result = await saveProfile(io, 'large', stored);
    expect(result.where).toBe(join(home, 'credentials.json'));
    expect(stand.calls.some((call) => call.input !== undefined)).toBe(false);
    expect(privateEnough(result.where)).toBe(true);
    expect(await loadProfile(io, 'large')).toEqual(stored);
  });

  it('keeps more than one, and forgets one or all of them', async () => {
    const io = ioFor({ platform: 'win32', spawn: standIn().spawn });
    await saveProfile(io, 'work', profile('rio_pat_work'));
    await saveProfile(io, 'home', profile('rio_pat_home'));
    expect((await loadProfile(io, 'work'))?.token).toBe('rio_pat_work');
    expect((await loadProfile(io, 'home'))?.token).toBe('rio_pat_home');
    expect(await removeProfile(io, 'work')).toBe(true);
    expect(await loadProfile(io, 'work')).toBeNull();
    expect((await loadProfile(io, 'home'))?.token).toBe('rio_pat_home');
    expect(await removeProfile(io, null)).toBe(true);
    expect(await loadProfile(io, 'home')).toBeNull();
    expect(await removeProfile(io, null)).toBe(false);
  });

  it('names the profile a run means', () => {
    const io = ioFor({ platform: 'win32', spawn: standIn().spawn });
    expect(profileName(io)).toBe('default');
    expect(profileName(io, 'work')).toBe('work');
    expect(profileName(ioFor({ platform: 'win32', env: { RIOSOMA_PROFILE: 'work' } }))).toBe('work');
  });

  it('reads a file it can’t make sense of as one with nothing in it', async () => {
    const path = join(home, 'credentials.json');
    writeFileSync(path, 'this is not JSON');
    const io = ioFor({ platform: 'win32', spawn: standIn().spawn });
    expect(await loadProfile(io, 'default')).toBeNull();
    // What's there is replaced rather than kept, so a broken file can't stop a sign-in.
    await saveProfile(io, 'default', profile('rio_pat_after_a_broken_file'));
    expect((await loadProfile(io, 'default'))?.token).toBe('rio_pat_after_a_broken_file');
  });
});

function chmodWide(path: string): void {
  chmodSync(path, 0o644);
}
