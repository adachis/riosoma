import { z } from 'zod';
import { ErrorBody } from './errors.js';
import { AttachmentMeta } from './data/files.js';

/**
 * Cloud drives people add attachments from, each through an account they connect for themselves
 * with OAuth 2.  An admin sets up each provider's app once, in settings or in admin settings, and
 * can turn a provider off.
 *
 * Routes:
 * - `GET /api/oauth/start/:provider` (session): sends the browser to the provider to connect, and
 *   `GET /api/oauth/callback/:provider` brings it back, then on to `next`.
 * - `GET /api/connections` (session): each provider, whether it's offered, and the person's account.
 * - `DELETE /api/connections/:provider` (session): disconnects the person's account.
 * - `GET /api/connections/:provider/files?folder=&query=&cursor=` (session): one page of a folder,
 *   or of a search, in Dropbox or Box.
 * - `GET /api/connections/:provider/thumbnails/:fileId` (session): a small picture of a file.
 * - `GET /api/connections/google/picker` (session): what Google's Picker needs to open.
 * - `POST /api/tables/:tableId/fields/:fieldId/records/:recordId/imports` (edit access to the
 *   record): copies one picked file into storage, answering with `ImportEvent` lines as it goes.
 * - `GET /api/admin/integrations`, `PUT /api/admin/integrations/:provider`, and
 *   `POST /api/admin/integrations/:provider/test` (admins with the Integrations role).
 */
export const CLOUD_PROVIDERS = ['dropbox', 'box', 'google'] as const;
export const CloudProvider = z.enum(CLOUD_PROVIDERS);
export type CloudProvider = z.infer<typeof CloudProvider>;

export const CALENDAR_PROVIDERS = ['google-calendar', 'microsoft-calendar'] as const;
export const CONNECTED_PROVIDERS = [
  ...CLOUD_PROVIDERS,
  ...CALENDAR_PROVIDERS,
  'github',
  'xero',
  'quickbooks',
] as const;
export const ConnectedProvider = z.enum(CONNECTED_PROVIDERS);
export type ConnectedProvider = z.infer<typeof ConnectedProvider>;

/** The drives with Riosoma's own picker.  Google Drive uses Google's. */
export const BROWSED_PROVIDERS = ['dropbox', 'box'] as const;
export const BrowsedProvider = z.enum(BROWSED_PROVIDERS);
export type BrowsedProvider = z.infer<typeof BrowsedProvider>;

export const AccountSettingChoices = z.record(
  z.string(),
  z.array(z.object({ value: z.string().min(1).max(255), label: z.string().min(1) })),
);
export type AccountSettingChoices = z.infer<typeof AccountSettingChoices>;

export const ConnectedAccount = z.object({
  settingChoices: AccountSettingChoices.optional(),
  id: z.string().optional(),
  /** App sources that will stop syncing if this account is disconnected. */
  sources: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  /** The name the provider knows the person by */
  name: z.string(),
  email: z.string().nullable(),
  connectedAt: z.string(),
  /** The provider stopped accepting the stored tokens, so the person has to connect again */
  needsReconnect: z.boolean(),
});
export type ConnectedAccount = z.infer<typeof ConnectedAccount>;

export const ProviderConnection = z.object({
  provider: ConnectedProvider,
  /** Set up by an admin and not turned off, so the attachment panel offers it */
  available: z.boolean(),
  account: ConnectedAccount.nullable(),
});
export type ProviderConnection = z.infer<typeof ProviderConnection>;

export const ConnectionsView = z.object({ providers: z.array(ProviderConnection) });
export type ConnectionsView = z.infer<typeof ConnectionsView>;

/** One entry of a folder in Dropbox or Box. */
export const DriveEntry = z.object({
  id: z.string().min(1).max(500),
  name: z.string(),
  kind: z.enum(['file', 'folder']),
  /** Bytes, for files */
  size: z.number().int().nonnegative().nullable(),
  modifiedAt: z.string().nullable(),
  /** Whether the provider makes a picture of it, fetched through the thumbnails route */
  thumbnail: z.boolean(),
});
export type DriveEntry = z.infer<typeof DriveEntry>;

export const DriveListing = z.object({
  entries: z.array(DriveEntry),
  /** Present when there's more to read */
  cursor: z.string().nullable(),
});
export type DriveListing = z.infer<typeof DriveListing>;

export const GooglePickerConfig = z.object({
  /** The person's own access token, scoped to the files they pick */
  accessToken: z.string(),
  apiKey: z.string(),
  /** The Google Cloud project number, which lets the Picker grant access to what's picked */
  appId: z.string(),
});
export type GooglePickerConfig = z.infer<typeof GooglePickerConfig>;

/** What a Google Doc, Sheet, or Slides file becomes.  Each Google type allows PDF and its own. */
export const DRIVE_EXPORT_FORMATS = ['pdf', 'docx', 'xlsx', 'pptx'] as const;
export const DriveExportFormat = z.enum(DRIVE_EXPORT_FORMATS);
export type DriveExportFormat = z.infer<typeof DriveExportFormat>;

export const FileImportRequest = z.object({
  provider: CloudProvider,
  /** The provider's ID for the file */
  fileId: z.string().min(1).max(500),
  /** For Google Docs, Sheets, and Slides: PDF unless the person chose the Office format */
  exportAs: DriveExportFormat.optional(),
});
export type FileImportRequest = z.infer<typeof FileImportRequest>;

/** One line of an import's answer, as newline-delimited JSON. */
export const ImportEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('progress'),
    bytes: z.number().int().nonnegative(),
    /** Null when the provider doesn't say, as for an exported Google file */
    total: z.number().int().nonnegative().nullable(),
  }),
  z.object({ kind: z.literal('done'), file: AttachmentMeta }),
  z.object({ kind: z.literal('failed'), error: ErrorBody.shape.error }),
]);
export type ImportEvent = z.infer<typeof ImportEvent>;

/** A provider's app, as admin settings show it.  Secrets go in and never come back out. */
export const IntegrationView = z.object({
  provider: ConnectedProvider,
  tenantId: z.string().default(''),
  clientId: z.string(),
  hasSecret: z.boolean(),
  /** Google only: the Picker's browser key, which isn't secret since every browser gets it */
  apiKey: z.string().nullable(),
  /** The app comes from the server's settings, which win over anything saved here */
  fromEnvironment: z.boolean(),
  /** An admin hasn't turned it off */
  enabled: z.boolean(),
  /** Everything the provider needs is there */
  configured: z.boolean(),
  /** The exact address to register with the provider */
  redirectUri: z.string(),
});
export type IntegrationView = z.infer<typeof IntegrationView>;

export const IntegrationUpdate = z.object({
  tenantId: z
    .string()
    .trim()
    .max(253)
    .regex(/^[a-zA-Z0-9.-]*$/)
    .optional(),
  clientId: z.string().trim().max(500).optional(),
  /** Leave it out to keep the stored secret, or send an empty string to remove it */
  clientSecret: z.string().max(2000).optional(),
  apiKey: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
});
export type IntegrationUpdate = z.infer<typeof IntegrationUpdate>;

export const IntegrationTestResult = z.object({
  ok: z.boolean(),
  messageKey: z.string(),
});
export type IntegrationTestResult = z.infer<typeof IntegrationTestResult>;
