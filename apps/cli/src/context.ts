import { message } from './messages.js';
import {
  RioApiError,
  RioClient,
  RioClientError,
  type FilterGroup,
  type Sort,
  type TableSchema,
} from '@riosoma/sdk';
import { splitList, type Args } from './args.js';
import { loadProfile, profileName, saveProfile, type StoredProfile } from './credentials.js';
import { Failure, type Io } from './io.js';

/**
 * The server a command talks to, and the credential it talks with.  Both come from three places,
 * in one order: what the command was given, what the environment says, and what a previous `login`
 * stored.  That order is what lets a person store one credential for their server and still point
 * one command somewhere else without disturbing it.
 */

const DATABASE_ID = /^db[0-9A-Za-z]{14}$/;
const FIELD_ID = /^fld[0-9A-Za-z]{14}$/;

/** The options every command that talks to a server takes. */
export const GLOBAL_FLAGS = {
  url: { value: true, help: message('cli.context.theServerToTalkToAsAddress') },
  token: { value: true, help: message('cli.cli.aPersonalAccessTokenInsteadOfThe') },
  profile: { value: true, help: message('cli.context.whichStoredCredentialToUseWhenMore') },
  json: { short: 'j', help: message('cli.cli.printJsonInsteadOfATable') },
  quiet: { help: message('cli.context.printOnlyWhatTheCommandWasAsked') },
} as const;

export interface Session {
  client: RioClient;
  url: string;
  profile: string;
  /** Where the credential came from, which a line can say about a run */
  source: string;
  /** The stored profile this run may write back to, which a token from the environment has none */
  stored: StoredProfile | null;
}

/** A client for the server this command means, with a credential from wherever one was given. */
export async function session(args: Args, io: Io): Promise<Session> {
  const profile = profileName(io, args.string('profile'));
  const stored = await loadProfile(io, profile);
  const url = args.string('url') ?? io.env.RIOSOMA_URL ?? stored?.url;
  const token = args.string('token') ?? io.env.RIOSOMA_TOKEN;
  if (!url) throw new Failure(message('cli.context.noServerWasNamedSignInWith'));
  const options = {
    baseUrl: url,
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.sleep ? { sleep: io.sleep } : {}),
  };
  if (token)
    return {
      client: new RioClient({ ...options, token }),
      url,
      profile,
      source:
        token === args.string('token')
          ? message('cli.context.theTokenOption')
          : message('cli.context.theRiosomaTokenVariable'),
      stored: null,
    };
  if (!stored)
    throw new Failure(message('cli.context.noCredentialIsStoredForAndNone', { profile: profile, url: url }));
  if (stored.url !== url)
    throw new Failure(
      message('cli.context.theStoredCredentialForIsForNot', {
        profile: profile,
        value2: stored.url,
        url: url,
      }),
    );
  const client = new RioClient({
    ...options,
    ...(stored.kind === 'token'
      ? { token: stored.token }
      : {
          accessToken: stored.accessToken,
          refreshToken: stored.refreshToken,
          clientId: stored.clientId,
          expiresAt: stored.expiresAt ?? null,
          // A refresh that isn't written back is a sign-in that ends an hour later.
          onTokens: async (tokens) => {
            const now = io.now?.() ?? Date.now();
            await saveProfile(io, profile, {
              ...stored,
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token ?? stored.refreshToken,
              expiresAt: Number.isFinite(tokens.expires_in) ? now + tokens.expires_in * 1_000 : null,
              savedAt: new Date(now).toISOString(),
            }).catch(() => undefined);
          },
        }),
  });
  return {
    client,
    url,
    profile,
    source: message('cli.context.theStoredCredential', { profile: profile }),
    stored,
  };
}

/** The database a command was pointed at, by ID or by name. */
export async function databaseFor(
  client: RioClient,
  nameOrId: string,
): Promise<{ id: string; name: string }> {
  if (DATABASE_ID.test(nameOrId)) {
    const databases = await client.databases.list();
    const found = databases.find((database) => database.id === nameOrId);
    if (found) return { id: found.id, name: found.name };
    // A token may reach a database its listing left out, so the ID is still worth a try.
    return { id: nameOrId, name: nameOrId };
  }
  const databases = await client.databases.list();
  const found = databases.find((database) => database.name === nameOrId);
  if (!found)
    throw new Failure(message('cli.context.thereSNoDatabaseCalledThisCredential', { nameOrId: nameOrId }));
  return { id: found.id, name: found.name };
}

/** The table a command was pointed at, by ID or by name, with the fields and views it has. */
export async function tableFor(
  client: RioClient,
  databaseId: string,
  nameOrId: string,
): Promise<TableSchema> {
  try {
    return await client.tables.get(databaseId, nameOrId);
  } catch (error) {
    if (error instanceof RioClientError || (error instanceof RioApiError && error.status === 404))
      throw new Failure(
        message('cli.context.thereSNoTableCalledInThis', { nameOrId: nameOrId, databaseId: databaseId }),
      );
    throw error;
  }
}

/** A field's ID from its name, since a filter and a sort name fields by ID. */
export function fieldIds(table: TableSchema, names: readonly string[]): string[] {
  return names.map((name) => {
    const found =
      table.fields.find((field) => field.id === name) ?? table.fields.find((field) => field.name === name);
    if (!found)
      throw new Failure(
        message('cli.context.theTableHasNoFieldCalledRiosoma', {
          value1: table.name,
          name: name,
          value3: table.databaseId,
        }),
      );
    return found.id;
  });
}

/**
 * A sort from the way a person writes one: `Field:desc`, or just `Field` for an ascending sort.
 * Fields go by name or ID, and the API takes IDs.
 */
export function sorts(table: TableSchema, value: string | undefined): Sort[] {
  if (!value) return [];
  return splitList(value).map((entry) => {
    const separator = entry.lastIndexOf(':');
    const name = separator < 0 ? entry : entry.slice(0, separator);
    const direction = separator < 0 ? 'asc' : entry.slice(separator + 1).toLowerCase();
    if (direction !== 'asc' && direction !== 'desc')
      throw new Failure(message('cli.context.aSortIsFieldAscOrField', { entry: entry }));
    return { fieldId: fieldIds(table, [name])[0]!, direction: direction as Sort['direction'] };
  });
}

/** A filter group as JSON, with field names in it replaced by the IDs the API wants. */
export function filter(table: TableSchema, value: string | undefined): FilterGroup | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Failure(message('cli.context.theFilterIsnTJson', { value1: (error as Error).message }), {
      cause: error,
    });
  }
  return byId(table, parsed) as FilterGroup;
}

function byId(table: TableSchema, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => byId(table, item));
  if (!value || typeof value !== 'object') return value;
  const found = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(found)) {
    if (key === 'fieldId' && typeof item === 'string' && !FIELD_ID.test(item)) {
      next[key] = fieldIds(table, [item])[0]!;
      continue;
    }
    next[key] = byId(table, item);
  }
  return next;
}
