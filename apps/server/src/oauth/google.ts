import { z } from 'zod';
import { AppError, type DriveExportFormat } from '@riosoma/contracts';
import { bodyStream, driveFetch, driveJson, providerFailed, type ImportableDrive } from './drive.js';
import type { OAuthProvider } from './providers.js';

/**
 * Google Drive, with the `drive.file` scope: Riosoma sees only the files a person picks in
 * Google's Picker, never the rest of their drive.  Google Docs, Sheets, and Slides have no bytes of
 * their own, so they're exported, as PDF or as their Office format.
 */
export const GOOGLE_API = 'https://www.googleapis.com';
export const GOOGLE_OAUTH = 'https://oauth2.googleapis.com';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const OFFICE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

/** What each Google type can become, PDF first since it's the default. */
export const GOOGLE_EXPORTS: Record<string, Partial<Record<DriveExportFormat, string>>> = {
  'application/vnd.google-apps.document': { pdf: 'application/pdf', docx: OFFICE.docx },
  'application/vnd.google-apps.spreadsheet': { pdf: 'application/pdf', xlsx: OFFICE.xlsx },
  'application/vnd.google-apps.presentation': { pdf: 'application/pdf', pptx: OFFICE.pptx },
  'application/vnd.google-apps.drawing': { pdf: 'application/pdf' },
};

export const google: OAuthProvider = {
  id: 'google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: `${GOOGLE_OAUTH}/token`,
  scope: DRIVE_FILE_SCOPE,
  // Consent every time is what makes Google send a refresh token again after a reconnect.
  authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  needsApiKey: true,
  async account(accessToken, signal) {
    const response = await fetch(
      `${GOOGLE_API}/drive/v3/about?fields=${encodeURIComponent('user(displayName,emailAddress,permissionId)')}`,
      { headers: { authorization: `Bearer ${accessToken}` }, signal },
    );
    if (!response.ok) throw providerFailed();
    const { user } = z
      .object({
        user: z.object({
          displayName: z.string(),
          emailAddress: z.string().optional(),
          permissionId: z.string(),
        }),
      })
      .parse(await response.json());
    return { id: user.permissionId, name: user.displayName, email: user.emailAddress ?? null };
  },
  async revoke(tokens, _app, signal) {
    await fetch(`${GOOGLE_OAUTH}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken }),
      signal,
    });
  },
  async testApiKey(apiKey, signal) {
    // A good key without a person's token is refused for the missing sign-in, or for the referrer
    // it's restricted to, and only a bad key is refused as a bad key.
    const response = await fetch(
      `${GOOGLE_API}/drive/v3/about?fields=kind&key=${encodeURIComponent(apiKey)}`,
      {
        signal,
      },
    );
    const text = await response.text().catch(() => '');
    if (response.status >= 500) return { ok: false, messageKey: 'drives.test.unreachable' };
    if (response.status === 400 && /API_KEY_INVALID|keyInvalid|API key not valid/.test(text))
      return { ok: false, messageKey: 'drives.test.apiKey' };
    return { ok: true, messageKey: 'drives.test.ok' };
  },
};

/** The Google Cloud project number, which leads every OAuth client ID. */
export function projectNumber(clientId: string): string {
  return /^(\d+)-/.exec(clientId)?.[1] ?? '';
}

const File = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.coerce.number().optional(),
});

const EXTENSIONS: Record<DriveExportFormat, string> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
};

function withExtension(name: string, format: DriveExportFormat): string {
  const extension = `.${EXTENSIONS[format]}`;
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;

export const googleDrive: ImportableDrive = {
  async open(access, fileId, exportAs, signal) {
    if (!DRIVE_ID.test(fileId)) throw new AppError('not_found', 'drives.fileMissing');
    const base = `${GOOGLE_API}/drive/v3/files/${fileId}`;
    const file = File.parse(
      await driveJson(access, `${base}?fields=id,name,mimeType,size&supportsAllDrives=true`, {
        signal,
        // Google answers a file the app wasn't granted, or that's gone, with 404.
        missing: [403, 404],
      }),
    );
    const exports = GOOGLE_EXPORTS[file.mimeType];
    if (file.mimeType.startsWith('application/vnd.google-apps.') && !exports)
      throw new AppError('validation_failed', 'drives.cantImport');
    if (!exports) {
      if (exportAs) throw new AppError('validation_failed', 'drives.exportFormat');
      const response = await driveFetch(access, `${base}?alt=media&supportsAllDrives=true`, { signal });
      return { name: file.name, size: file.size ?? null, body: bodyStream(response) };
    }
    const format = exportAs ?? 'pdf';
    const mimeType = exports[format];
    if (!mimeType) throw new AppError('validation_failed', 'drives.exportFormat');
    const response = await driveFetch(access, `${base}/export?mimeType=${encodeURIComponent(mimeType)}`, {
      signal,
      explain: exportRefusal,
    });
    return { name: withExtension(file.name, format), size: null, body: bodyStream(response) };
  },
};

/**
 * Google refuses to export anything over its export limit with 403 and a reason that says so.
 * This reads that one refusal out, so the person hears what happened rather than a general failure.
 */
async function exportRefusal(response: Response): Promise<AppError | null> {
  if (response.status !== 403) return null;
  const text = await response.text().catch(() => '');
  return /exportSizeLimitExceeded/.test(text)
    ? new AppError('validation_failed', 'drives.exportTooLarge')
    : new AppError('unavailable', 'drives.providerFailed');
}
