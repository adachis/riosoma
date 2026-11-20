import { message } from './messages.js';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Failure, type Io } from './io.js';

/**
 * Where a credential is kept between runs.
 *
 * A token is a way into someone's account, so it goes in the operating system's keychain where
 * there is one, and in a file only this person can read where there isn't.  The keychain is
 * reached by running the program the platform ships for it, which keeps the tool free of
 * dependencies.  Where that program is missing, or the platform has none, the file is used and the
 * tool says which of the two it chose.
 */

/** The name the credential is stored under in the keychain */
export const SERVICE = 'riosoma-cli';
export const ACCOUNT = 'credentials';
/** The file's name when a keychain isn't available */
export const FILE_NAME = 'credentials.json';

export interface StoredProfile {
  /** The server this credential is for */
  url: string;
  kind: 'token' | 'oauth';
  /** A personal access token, for `kind: 'token'` */
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  /** When the access token stops working, in milliseconds since the epoch */
  expiresAt?: number | null;
  scopes?: string[];
  /** Who signed in, for the line the tool prints about a stored profile */
  person?: string;
  savedAt: string;
}

export interface Profiles {
  version: 1;
  profiles: Record<string, StoredProfile>;
}

/** Somewhere credentials are kept, and a way to say which one was used. */
export interface Vault {
  readonly where: string;
  read(): Promise<Profiles | null>;
  write(profiles: Profiles): Promise<void>;
  /** Takes everything out, which is what signing out does */
  clear(): Promise<void>;
}

function empty(): Profiles {
  return { version: 1, profiles: {} };
}

function parse(text: string): Profiles | null {
  try {
    const found = JSON.parse(text) as Partial<Profiles>;
    if (!found || typeof found !== 'object' || !found.profiles || typeof found.profiles !== 'object')
      return null;
    return { version: 1, profiles: found.profiles as Record<string, StoredProfile> };
  } catch {
    return null;
  }
}

/** A file only its owner may read, which is the fallback wherever there's no keychain. */
export function fileVault(path: string): Vault {
  return {
    where: path,
    async read() {
      try {
        return parse(readFileSync(path, 'utf8'));
      } catch {
        return null;
      }
    },
    async write(profiles) {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory()) throw new Failure(message('cli.credentials.writeFailed'));
      chmodSync(directory, 0o700);
      const temporary = mkdtempSync(join(directory, '.credentials-'));
      try {
        const file = join(temporary, FILE_NAME);
        writeFileSync(file, `${JSON.stringify(profiles, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        renameSync(file, path);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
    async clear() {
      rmSync(path, { force: true });
    },
  };
}

/** The keychain this machine has, or null when it has none the tool can use. */
export function keychainVault(io: Io): Vault | null {
  const platform = io.platform ?? process.platform;
  const run = io.spawn;
  if (!run || (platform !== 'darwin' && platform !== 'linux')) return null;
  return profileKeychain(run, platform === 'darwin');
}

/** Each profile has its own item so a write carries only that profile's credentials. */
function profileKeychain(run: NonNullable<Io['spawn']>, darwin: boolean): Vault {
  const command = darwin ? 'security' : 'secret-tool';
  const attributes = (name: string) =>
    darwin ? ['-s', SERVICE, '-a', name] : ['service', SERVICE, 'account', name];
  const decode = (text: string) => (darwin ? Buffer.from(text, 'base64').toString('utf8') : text);
  const account = (name: string) => `profile-${Buffer.from(name).toString('base64url')}`;
  const read = async (name: string): Promise<string | null> => {
    const result = await run(
      command,
      darwin ? ['find-generic-password', ...attributes(name), '-w'] : ['lookup', ...attributes(name)],
    );
    if (result.status === (darwin ? 44 : 1) || result.status === 127) return null;
    if (result.status !== 0) throw new Failure(message('cli.credentials.readFailed'));
    return result.stdout.trim();
  };
  const inputFor = (name: string, value: unknown): { args: string[]; input: string } => {
    const text = JSON.stringify(value);
    if (!darwin)
      return {
        args: ['store', `--label=${message('cli.credentials.label')}`, ...attributes(name)],
        input: text,
      };
    // Base64 keeps quotes, newlines, and backslashes out of the command parser.
    const encoded = Buffer.from(text).toString('base64');
    const input = `add-generic-password -U -s ${SERVICE} -a ${name} -w ${encoded}\n`;
    if (Buffer.byteLength(input) >= 4096) throw new Failure(message('cli.credentials.tooLarge'));
    return { args: ['-i'], input };
  };
  const write = async ({ args, input }: ReturnType<typeof inputFor>) => {
    const result = await run(command, args, input);
    if (result.status !== 0) throw new Failure(message('cli.credentials.writeFailed'));
  };
  const remove = async (name: string) => {
    const result = await run(command, [darwin ? 'delete-generic-password' : 'clear', ...attributes(name)]);
    if (result.status !== 0 && !(darwin && result.status === 44))
      throw new Failure(message('cli.credentials.deleteFailed'));
  };
  const names = (text: string): string[] => {
    try {
      const index = JSON.parse(decode(text)) as {
        version?: number;
        names?: unknown;
      };
      if (
        index.version === 2 &&
        Array.isArray(index.names) &&
        index.names.every((name) => typeof name === 'string')
      )
        return index.names as string[];
    } catch {
      // Older versions stored all profiles in one JSON item.
    }
    throw new Failure(message('cli.credentials.readFailed'));
  };
  return {
    where: message(darwin ? 'cli.credentials.theMacosKeychain' : 'cli.credentials.theFreedesktopKeyring'),
    async read() {
      const text = await read(ACCOUNT);
      if (text === null) return null;
      const legacy = parse(text);
      if (legacy) return legacy;
      const entries: Array<[string, StoredProfile]> = [];
      for (const name of names(text)) {
        const value = await read(account(name));
        if (value === null) continue;
        try {
          entries.push([name, JSON.parse(decode(value)) as StoredProfile]);
        } catch {
          throw new Failure(message('cli.credentials.readFailed'));
        }
      }
      return { version: 1, profiles: Object.fromEntries(entries) };
    },
    async write(profiles) {
      const text = await read(ACCOUNT);
      const previous = text === null || parse(text) ? [] : names(text);
      const next = Object.keys(profiles.profiles);
      // Validate every input before changing anything, including the index with no secrets.
      const inputs = next.map((name) => inputFor(account(name), profiles.profiles[name]));
      const index = inputFor(ACCOUNT, { version: 2, names: next });
      const added = next.filter((name) => !previous.includes(name));
      try {
        for (const input of inputs) await write(input);
        for (const name of previous) if (!next.includes(name)) await remove(account(name));
        await write(index);
      } catch (error) {
        for (const name of added) await remove(account(name));
        throw error;
      }
    },
    async clear() {
      const text = await read(ACCOUNT);
      if (text === null) return;
      if (!parse(text)) for (const name of names(text)) await remove(account(name));
      await remove(ACCOUNT);
    },
  };
}

/**
 * Where this run keeps credentials: the keychain unless it was turned off, and the file when there
 * is no keychain.  A read falls back to the file, so a credential saved before a keychain was
 * available is still found.
 */
export function vaultsFor(io: Io): Vault[] {
  const file = fileVault(join(io.home ?? join('.config', 'riosoma'), FILE_NAME));
  const off = ['off', '0', 'false', 'no'].includes(String(io.env.RIOSOMA_KEYCHAIN ?? '').toLowerCase());
  const keychain = off ? null : keychainVault(io);
  return keychain ? [keychain, file] : [file];
}

export async function loadProfiles(io: Io): Promise<Profiles> {
  for (const vault of vaultsFor(io)) {
    const found = await vault.read().catch(() => null);
    if (found) return found;
  }
  return empty();
}

/** Saves one profile, in the first vault that will keep it, and says where it went. */
export async function saveProfile(io: Io, name: string, profile: StoredProfile): Promise<{ where: string }> {
  const all = vaultsFor(io);
  const stored = await loadProfiles(io);
  const next: Profiles = { version: 1, profiles: { ...stored.profiles, [name]: profile } };
  let lastError: unknown = null;
  for (const vault of all) {
    try {
      await vault.write(next);
      // A secret in two places is one too many, so the fallback forgets what it held.
      for (const other of all) if (other !== vault) await other.clear().catch(() => undefined);
      return { where: vault.where };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Failure(message('cli.credentials.thereWasNowhereToKeepThisCredential'), { cause: lastError });
}

export async function loadProfile(io: Io, name: string): Promise<StoredProfile | null> {
  const stored = await loadProfiles(io);
  return stored.profiles[name] ?? null;
}

/** Forgets one profile, or all of them, and says whether there was anything to forget. */
export async function removeProfile(io: Io, name: string | null): Promise<boolean> {
  const all = vaultsFor(io);
  let removed = false;
  const failures: unknown[] = [];
  for (const vault of all) {
    try {
      const found = await vault.read();
      if (!found) continue;
      if (name === null) {
        await vault.clear();
        removed = true;
        continue;
      }
      if (!found.profiles[name]) continue;
      const rest = { ...found.profiles };
      delete rest[name];
      if (Object.keys(rest).length) await vault.write({ version: 1, profiles: rest });
      else await vault.clear();
      removed = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new Failure(message('cli.credentials.deleteFailed'), { cause: failures[0] });
  return removed;
}

/** The profile a run means, from its flag or the environment, or the one it saved last. */
export function profileName(io: Io, given?: string): string {
  return given || io.env.RIOSOMA_PROFILE || 'default';
}

/** What the tool may say out loud about a stored credential, which is never the credential. */
export function describeProfile(profile: StoredProfile): string {
  const who = profile.person ? message('cli.credentials.as', { value1: profile.person }) : '';
  const what =
    profile.kind === 'token'
      ? message('cli.credentials.aPersonalAccessToken')
      : message('cli.credentials.oauthTokens');
  return message('cli.credentials.with', { value1: profile.url, who: who, what: what });
}

/** Whether a stored file is still only its owner's, which a test checks and a warning mentions. */
export function privateEnough(path: string): boolean {
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}
