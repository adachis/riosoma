import { z } from 'zod';
import type { DriveEntry, DriveListing } from '@riosoma/contracts';
import {
  bodyStream,
  driveFetch,
  driveJson,
  extensionOf,
  gatherListing,
  fileMissing,
  PICTURE_EXTENSIONS,
  providerFailed,
  type BrowsableDrive,
  type ImportableDrive,
} from './drive.js';
import { limited, type OAuthProvider } from './providers.js';

/**
 * Box, through its content API: an OAuth 2 app with user authentication that reads the files the
 * person can.  The top folder is `0`.  Box hands out a new refresh token with every refresh, which
 * the token store keeps.
 */
export const BOX_API = 'https://api.box.com';

/** The most entries Box gives in one answer, for a folder and for a search. */
const FOLDER_PAGE = 1_000;
const SEARCH_PAGE = 200;
const FIELDS = 'id,type,name,size,modified_at';
const Id = /^\d{1,30}$/;

export const box: OAuthProvider = {
  id: 'box',
  authorizeUrl: 'https://account.box.com/api/oauth2/authorize',
  tokenUrl: `${BOX_API}/oauth2/token`,
  // Box grants what the app is set up for, so the request names no scope.
  scope: '',
  async account(accessToken, signal) {
    const response = await fetch(`${BOX_API}/2.0/users/me?fields=id,name,login`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (!response.ok) throw providerFailed();
    const body = z
      .object({ id: z.string(), name: z.string(), login: z.string().optional() })
      .parse(await response.json());
    return { id: body.id, name: body.name, email: body.login ?? null };
  },
  async revoke(tokens, app, signal) {
    await fetch(`${BOX_API}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        token: tokens.refreshToken ?? tokens.accessToken,
      }),
      signal,
    });
  },
};

const Item = z.object({
  type: z.string(),
  id: z.string(),
  name: z.string(),
  size: z.number().optional(),
  modified_at: z.string().nullable().optional(),
});

function entryOf(value: unknown): DriveEntry | null {
  const parsed = Item.safeParse(value);
  // Web links and anything else that isn't a file or a folder can't be copied.
  if (!parsed.success || (parsed.data.type !== 'file' && parsed.data.type !== 'folder')) return null;
  const item = parsed.data;
  const file = item.type === 'file';
  return {
    id: item.id,
    name: item.name,
    kind: file ? 'file' : 'folder',
    size: file ? (item.size ?? null) : null,
    modifiedAt: item.modified_at ?? null,
    thumbnail: file && PICTURE_EXTENSIONS.has(extensionOf(item.name)),
  };
}

function checkedId(id: string): string {
  if (!Id.test(id)) throw fileMissing();
  return id;
}

export const boxDrive: BrowsableDrive & ImportableDrive = {
  async list(access, { folder, query, cursor, signal }): Promise<DriveListing> {
    if (query) {
      const search = async (from: string): Promise<DriveListing> => {
        const offset = /^\d{1,9}$/.test(from) ? Number(from) : 0;
        const params = new URLSearchParams({
          query,
          fields: FIELDS,
          limit: String(SEARCH_PAGE),
          offset: String(offset),
        });
        const answer = await driveJson<{ entries: unknown[]; total_count?: number }>(
          access,
          `${BOX_API}/2.0/search?${params}`,
          { signal },
        );
        const next = offset + answer.entries.length;
        return {
          entries: answer.entries.flatMap((value) => entryOf(value) ?? []),
          cursor: answer.entries.length && next < (answer.total_count ?? 0) ? String(next) : null,
        };
      };
      return gatherListing(() => search(cursor), search, { sort: false });
    }
    const page = async (marker: string): Promise<DriveListing> => {
      const params = new URLSearchParams({ fields: FIELDS, limit: String(FOLDER_PAGE), usemarker: 'true' });
      if (marker) params.set('marker', marker);
      const answer = await driveJson<{ entries: unknown[]; next_marker?: string | null }>(
        access,
        `${BOX_API}/2.0/folders/${checkedId(folder || '0')}/items?${params}`,
        { signal },
      );
      return {
        entries: answer.entries.flatMap((value) => entryOf(value) ?? []),
        cursor: answer.next_marker || null,
      };
    };
    return gatherListing(() => page(cursor), page, { sort: true });
  },

  async thumbnail(access, fileId, signal) {
    const response = await driveFetch(
      access,
      `${BOX_API}/2.0/files/${checkedId(fileId)}/thumbnail.jpg?min_height=128&min_width=128`,
      // A 202 means Box is still making it, and a redirect points at a generic placeholder.
      { signal: limited(signal), redirect: 'manual' },
    );
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return { type: 'image/jpeg', body: bodyStream(response) };
  },

  async open(access, fileId, _exportAs, signal) {
    const id = checkedId(fileId);
    const info = await driveJson<{ type?: string; name?: string; size?: number }>(
      access,
      `${BOX_API}/2.0/files/${id}?fields=id,type,name,size`,
      { signal },
    );
    // The content address redirects to a download that carries its own short-lived permission.
    const response = await driveFetch(access, `${BOX_API}/2.0/files/${id}/content`, { signal });
    // A 202 means the file isn't ready to download yet, such as one still being uploaded to Box.
    if (response.status === 202) {
      await response.body?.cancel().catch(() => undefined);
      throw providerFailed();
    }
    return {
      name: typeof info.name === 'string' ? info.name : 'file',
      size: typeof info.size === 'number' ? info.size : null,
      body: bodyStream(response),
    };
  },
};
