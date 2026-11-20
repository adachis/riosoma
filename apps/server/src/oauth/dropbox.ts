import { z } from 'zod';
import type { DriveEntry, DriveListing } from '@riosoma/contracts';
import {
  bodyStream,
  driveFetch,
  driveJson,
  extensionOf,
  gatherListing,
  PICTURE_EXTENSIONS,
  providerFailed,
  type BrowsableDrive,
  type ImportableDrive,
} from './drive.js';
import { refreshTokens } from './connections.js';
import { limited, type OAuthProvider } from './providers.js';

/**
 * Dropbox, through its HTTP API: an app with scoped access that reads file metadata and content
 * and the account's name.  Folders and files are named by their IDs (`id:…`), which survive moves.
 */
export const DROPBOX_API = 'https://api.dropboxapi.com';
export const DROPBOX_CONTENT = 'https://content.dropboxapi.com';

/** The most entries Dropbox gives in one answer, for a folder and for a search. */
const FOLDER_PAGE = 2_000;
const SEARCH_PAGE = 1_000;

export const dropbox: OAuthProvider = {
  id: 'dropbox',
  authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: `${DROPBOX_API}/oauth2/token`,
  scope: 'account_info.read files.metadata.read files.content.read',
  // Offline access is what brings a refresh token, since Dropbox's access tokens last hours.
  authorizeParams: { token_access_type: 'offline' },
  async account(accessToken, signal) {
    const response = await fetch(`${DROPBOX_API}/2/users/get_current_account`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: 'null',
      signal,
    });
    if (!response.ok) throw providerFailed();
    const body = z
      .object({
        account_id: z.string(),
        name: z.object({ display_name: z.string() }),
        email: z.string().optional(),
      })
      .parse(await response.json());
    return { id: body.account_id, name: body.name.display_name, email: body.email ?? null };
  },
  async revoke(tokens, app, signal) {
    // Dropbox revokes with an access token, and the stored one has usually expired by the time
    // someone disconnects, since they last hours.  So a fresh one is asked for first.  Revoking it
    // ends the refresh token behind it, and every access token from that, too.
    let accessToken = tokens.accessToken;
    try {
      accessToken = (await refreshTokens(dropbox, app, tokens)).accessToken;
    } catch {
      // Without a fresh token, the stored one is still worth a try.
    }
    await fetch(`${DROPBOX_API}/2/auth/token/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    });
  },
};

const Metadata = z.object({
  '.tag': z.string(),
  id: z.string().optional(),
  name: z.string(),
  size: z.number().optional(),
  server_modified: z.string().optional(),
  is_downloadable: z.boolean().optional(),
});
type Metadata = z.infer<typeof Metadata>;

function entryOf(metadata: Metadata): DriveEntry | null {
  if (!metadata.id || (metadata['.tag'] !== 'file' && metadata['.tag'] !== 'folder')) return null;
  const file = metadata['.tag'] === 'file';
  // Some files, such as Dropbox Paper documents, can only be exported, never downloaded.
  if (file && metadata.is_downloadable === false) return null;
  return {
    id: metadata.id,
    name: metadata.name,
    kind: file ? 'file' : 'folder',
    size: file ? (metadata.size ?? null) : null,
    modifiedAt: metadata.server_modified ?? null,
    thumbnail: file && PICTURE_EXTENSIONS.has(extensionOf(metadata.name)),
  };
}

/** Dropbox reads its arguments from a header, which has to stay ASCII. */
function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const dropboxDrive: BrowsableDrive & ImportableDrive = {
  async list(access, { folder, query, cursor, signal }): Promise<DriveListing> {
    // Dropbox answers a path it can't find with 409.
    const missing = [404, 409];
    if (query) {
      const search = async (body: unknown): Promise<DriveListing> => {
        const answer = await driveJson<{
          matches: Array<{ metadata: { metadata: unknown } }>;
          has_more: boolean;
          cursor?: string;
        }>(
          access,
          typeof body === 'object' && body && 'cursor' in body
            ? `${DROPBOX_API}/2/files/search/continue_v2`
            : `${DROPBOX_API}/2/files/search_v2`,
          { ...post(body), signal, missing },
        );
        const entries = answer.matches.flatMap((match) => {
          const parsed = Metadata.safeParse(match.metadata?.metadata);
          const entry = parsed.success ? entryOf(parsed.data) : null;
          return entry ? [entry] : [];
        });
        return { entries, cursor: answer.has_more && answer.cursor ? answer.cursor : null };
      };
      return gatherListing(
        () =>
          search(
            cursor ? { cursor } : { query, options: { max_results: SEARCH_PAGE, file_status: 'active' } },
          ),
        (next) => search({ cursor: next }),
        { sort: false },
      );
    }
    const page = async (
      body: { cursor: string } | { path: string; limit: number },
    ): Promise<DriveListing> => {
      const answer = await driveJson<{ entries: unknown[]; has_more: boolean; cursor: string }>(
        access,
        'cursor' in body
          ? `${DROPBOX_API}/2/files/list_folder/continue`
          : `${DROPBOX_API}/2/files/list_folder`,
        { ...post(body), signal, missing },
      );
      const entries = answer.entries.flatMap((value) => {
        const parsed = Metadata.safeParse(value);
        const entry = parsed.success ? entryOf(parsed.data) : null;
        return entry ? [entry] : [];
      });
      return { entries, cursor: answer.has_more ? answer.cursor : null };
    };
    return gatherListing(
      () => page(cursor ? { cursor } : { path: folder, limit: FOLDER_PAGE }),
      (next) => page({ cursor: next }),
      { sort: true },
    );
  },

  async thumbnail(access, fileId, signal) {
    const response = await driveFetch(access, `${DROPBOX_CONTENT}/2/files/get_thumbnail_v2`, {
      method: 'POST',
      headers: {
        'dropbox-api-arg': apiArg({
          resource: { '.tag': 'path', path: fileId },
          format: 'jpeg',
          size: 'w128h128',
          mode: 'fitone_bestfit',
        }),
      },
      signal: limited(signal),
      missing: [404, 409],
    });
    return { type: 'image/jpeg', body: bodyStream(response) };
  },

  async open(access, fileId, _exportAs, signal) {
    const response = await driveFetch(access, `${DROPBOX_CONTENT}/2/files/download`, {
      method: 'POST',
      headers: { 'dropbox-api-arg': apiArg({ path: fileId }) },
      signal,
      missing: [404, 409],
    });
    let result: { name?: unknown; size?: unknown } = {};
    try {
      result = JSON.parse(response.headers.get('dropbox-api-result') ?? '{}') as typeof result;
    } catch {
      // The name falls back below.
    }
    return {
      name: typeof result.name === 'string' ? result.name : 'file',
      size: typeof result.size === 'number' ? result.size : null,
      body: bodyStream(response),
    };
  },
};
