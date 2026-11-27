import { VaultProfiles, type CredentialSettings } from './credentials/settings.js';
import { validAddresses, validTarget } from './custom-domains/settings.js';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DatabaseProfile, ScannerAddress, type FeedKey, type InstallMethod } from '@riosoma/contracts';
import { isElectricityZone } from '@riosoma/ecologits';
import { startupMessage } from './startup-messages.js';
import { ConfigurationError } from './configuration-error.js';
import { profileFromUrl } from './database-url.js';
import { seal, unseal } from './secrets.js';
import { mailSettings, type MailTransportSettings } from './mail/settings.js';
import type { AzureSettings } from './data/files/azure-storage.js';
import type { S3Settings } from './data/files/s3-storage.js';
import type { StorageKind } from './data/files/storage.js';
import { providerKeysFrom } from './ai/provider-keys.js';

/** Where bug reports from feedback reach GitHub, unless the operator names a GitHub Enterprise server */
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
export const DEFAULT_HUB_URL = 'https://hub.riosoma.com';

/** The signed feed of releases the server checks once a day, unless an operator names another */
export const DEFAULT_UPDATE_FEED_URL = 'https://hub.riosoma.com/updates.json';

/** Where anonymous usage counts go, once the owner turns them on, unless an operator names another */
export const DEFAULT_TELEMETRY_URL = 'https://hub.riosoma.com/telemetry';

/** OpenFreeMap's Liberty style: free, with no key, and its tiles, fonts, and sprites on one host. */
export const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** A web address with no credentials in it, since every browser that opens a map view reads it. */
function isMapStyleUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
}

/** A storage service's address: `http` or `https`, with no credentials, query, or fragment in it. */
function isServiceUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

/** A folder inside a bucket or container, such as `riosoma/files`, which every key is put under. */
const KEY_PREFIX = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,512}$/;

/** A bare address a service sends as, with no display name beside it and one line. */
function isMailAddress(value: string): boolean {
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(value);
}

/**
 * The mail relay's address: `https`, or `http` on this machine, where a relay running beside the
 * server, or a catcher in a test, can stand in.  No credentials ride in it, since the post is signed.
 */
function isRelayUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  // An IPv6 host keeps its brackets in a URL, as in `http://[::1]:9000/`.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

/**
 * Runtime configuration.  Environment variables win, then the config file that the setup wizard
 * writes.  With no database configured the server runs in setup mode and serves only the wizard,
 * guarded by a one-time setup token printed to the log.
 */
const EnvSchema = z.object({
  RIOSOMA_VERSION: z.string().default('0.95.0'),
  RIOSOMA_SMOKE_PROFILE: z.string().optional(),
  RIOSOMA_DATABASE_WAIT_SECONDS: z.coerce.number().int().nonnegative().max(2_147_483).default(120),
  RIOSOMA_AUTOMATIONS_SCRIPT_MEMORY_MB: z.coerce
    .number()
    .min(16)
    .catch(64)
    .transform((value) => Math.min(Math.floor(value), 128))
    .default(64),
  RIOSOMA_AUTOMATIONS_SCRIPT_TIMEOUT_MS: z.coerce
    .number()
    .min(10)
    .catch(5000)
    .transform((value) => Math.min(Math.floor(value), 10000))
    .default(5000),
  RIOSOMA_AUTOMATIONS_SCRIPT_OUTPUT_KB: z.coerce
    .number()
    .min(1)
    .catch(256)
    .transform((value) => Math.min(Math.floor(value), 1024))
    .default(256),
  RIOSOMA_SCRIPTS_TIMEOUT_MS: z.coerce
    .number()
    .min(10)
    .catch(60000)
    .transform((value) => Math.min(Math.floor(value), 600000))
    .default(60000),
  RIOSOMA_OPENAI_API_KEY: z.string().optional(),
  RIOSOMA_ANTHROPIC_API_KEY: z.string().optional(),
  RIOSOMA_GEMINI_API_KEY: z.string().optional(),
  RIOSOMA_MISTRAL_API_KEY: z.string().optional(),
  RIOSOMA_OPENROUTER_API_KEY: z.string().optional(),
  RIOSOMA_OLLAMA_API_KEY: z.string().optional(),
  RIOSOMA_ANTHROPIC_WORKSPACE_ID: z.string().optional(),
  /** The electricity zone AI footprint estimates use unless an organization picks its own */
  RIOSOMA_AI_ELECTRICITY_ZONE: z
    .string()
    .trim()
    .refine((value) => isElectricityZone(value.toUpperCase()))
    .default('WOR'),
  RIOSOMA_SEARCH_URL: z.string().url().optional(),
  /** The operator chooses this internal service so report input cannot supply an address. */
  RIOSOMA_PDF_RENDERER_URL: z.string().trim().url().refine(isServiceUrl).optional(),
  RIOSOMA_PORT: z.coerce.number().int().positive().default(8080),
  RIOSOMA_HOST: z.string().default('0.0.0.0'),
  RIOSOMA_BASE_URL: z.string().url().optional(),
  RIOSOMA_TLS_ASK_TOKEN: z
    .string()
    .min(32)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  RIOSOMA_TLS_ASK_ADDRESSES: z.string().refine(validAddresses).default(''),
  RIOSOMA_CUSTOM_DOMAIN_TARGET: z.string().trim().refine(validTarget).optional(),
  RIOSOMA_CUSTOM_DOMAIN_LIMIT: z.coerce.number().int().min(1).max(10_000).default(50),
  RIOSOMA_DEMO_MODE: z.enum(['on', 'off']).default('off'),
  RIOSOMA_DEMO_ACCOUNT: z.string().email().optional(),
  RIOSOMA_DEMO_LINK: z.string().url().refine(isMapStyleUrl).optional(),
  RIOSOMA_DEMO_ADDRESS_LIMIT: z.coerce.number().int().positive().max(1000).default(10),
  RIOSOMA_DEMO_SESSION_LIMIT: z.coerce.number().int().positive().max(100000).default(1000),
  RIOSOMA_SESSION_IDLE_DAYS: z.coerce.number().int().positive().max(36500).default(7),
  RIOSOMA_SESSION_MAX_DAYS: z.coerce.number().int().positive().max(36500).default(30),
  RIOSOMA_SMTP_URL: z
    .string()
    .url()
    .refine((value) => /^smtps?:\/\//.test(value))
    .optional(),
  RIOSOMA_SMTP_ALLOW_PLAINTEXT: z.enum(['true', 'false']).default('false'),
  RIOSOMA_DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().max(2_147_483_647).default(30_000),
  RIOSOMA_SNAPSHOT_CACHE_MB: z.coerce.number().nonnegative().max(1_048_576).default(256),
  RIOSOMA_LIVE_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(15_000),
  RIOSOMA_LIVE_MAX_KEYS: z.coerce.number().int().min(1).max(10_000_000).default(250_000),
  /** Submissions one address may make to one public form in an hour */
  RIOSOMA_PUBLIC_FORM_HOURLY_LIMIT: z.coerce.number().int().min(1).max(100_000).default(20),
  /** Requests one address may make to shared view links in a minute */
  RIOSOMA_SHARED_VIEW_MINUTE_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(600),
  /** Requests one token may make to the Airtable-compatible API in a second */
  RIOSOMA_AIRTABLE_API_SECOND_LIMIT: z.coerce.number().int().min(1).max(100_000).default(50),
  /** Connections SQL editor queries run on, apart from the pool the rest of the app uses */
  RIOSOMA_SQL_POOL_MAX: z.coerce.number().int().min(1).max(100).default(3),
  /** Whether admins may give outside tools a PostgreSQL login that reads a database */
  RIOSOMA_SQL_OUTSIDE_LOGINS: z.enum(['on', 'off']).default('off'),
  /** Signature requests one person may send in an hour */
  RIOSOMA_SIGNATURE_REQUEST_HOURLY_LIMIT: z.coerce.number().int().min(1).max(100_000).default(20),
  /** Signers one person may add to signature requests in a day */
  RIOSOMA_SIGNATURE_SIGNER_DAILY_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(200),
  RIOSOMA_MAIL_FROM: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value))
    .optional(),
  RIOSOMA_MAIL_TRANSPORT: z.enum(['smtp', 'ses', 'acs', 'graph', 'gmail', 'relay']).default('smtp'),
  RIOSOMA_SES_REGION: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
  RIOSOMA_SES_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  RIOSOMA_SES_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  RIOSOMA_ACS_CONNECTION_STRING: z.string().trim().min(1).optional(),
  RIOSOMA_ACS_ENDPOINT: z.string().trim().url().refine(isServiceUrl).optional(),
  RIOSOMA_GRAPH_TENANT_ID: z.string().trim().min(1).optional(),
  RIOSOMA_GRAPH_CLIENT_ID: z.string().trim().min(1).optional(),
  RIOSOMA_GRAPH_CLIENT_SECRET: z.string().min(1).optional(),
  RIOSOMA_GRAPH_SENDER: z.string().trim().refine(isMailAddress).optional(),
  RIOSOMA_GMAIL_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
  RIOSOMA_GMAIL_SENDER: z.string().trim().refine(isMailAddress).optional(),
  RIOSOMA_MAIL_RELAY_URL: z.string().trim().url().refine(isRelayUrl).optional(),
  RIOSOMA_MAIL_RELAY_SECRET: z.string().min(1).optional(),
  RIOSOMA_CLAMAV_URL: z
    .string()
    .url()
    .refine((value) => ScannerAddress.safeParse(value).success)
    .optional(),
  RIOSOMA_CLAMAV_APPROVED_URLS: z
    .string()
    .trim()
    .refine((value) => value.split(',').every((address) => ScannerAddress.safeParse(address).success))
    .optional(),
  RIOSOMA_FILES_STORAGE: z.enum(['postgres', 'local', 's3', 'azure-blob']).default('postgres'),
  RIOSOMA_FILES_DIR: z.string().trim().min(1).optional(),
  RIOSOMA_ARCHIVE_WORK_DIR: z.string().trim().min(1).optional(),
  RIOSOMA_FILES_S3_ENDPOINT: z.string().trim().url().refine(isServiceUrl).optional(),
  RIOSOMA_FILES_S3_REGION: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
  RIOSOMA_FILES_S3_BUCKET: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,220}[A-Za-z0-9]$/)
    .optional(),
  RIOSOMA_FILES_S3_PREFIX: z.string().trim().regex(KEY_PREFIX).optional(),
  RIOSOMA_FILES_S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  RIOSOMA_FILES_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  RIOSOMA_FILES_S3_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  RIOSOMA_FILES_S3_SSE: z.enum(['AES256', 'aws:kms']).optional(),
  RIOSOMA_FILES_S3_KMS_KEY_ID: z.string().trim().min(1).optional(),
  RIOSOMA_FILES_AZURE_ACCOUNT: z
    .string()
    .trim()
    .regex(/^[a-z0-9]{3,24}$/)
    .optional(),
  RIOSOMA_FILES_AZURE_CONTAINER: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/)
    .optional(),
  RIOSOMA_FILES_AZURE_PREFIX: z.string().trim().regex(KEY_PREFIX).optional(),
  RIOSOMA_FILES_AZURE_ACCOUNT_KEY: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .optional(),
  RIOSOMA_FILES_AZURE_ENDPOINT: z.string().trim().url().refine(isServiceUrl).optional(),
  RIOSOMA_FILES_AZURE_CLIENT_ID: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
    .optional(),
  /** How long a download's signed address from the store works, or 0 to serve every download itself */
  RIOSOMA_FILES_SIGNED_URL_SECONDS: z.coerce.number().int().min(0).max(604_800).default(0),
  RIOSOMA_CONFIG_DIR: z.string().default('/config'),
  RIOSOMA_DRIVERS_DIR: z.string().optional(),
  RIOSOMA_DRIVER_INSTALLS: z.enum(['on', 'off']).default('on'),
  /**
   * Where the connector service answers, which runs the sources whose drivers the server doesn't
   * carry.  Unset, a server run from a source checkout starts the service itself.
   */
  RIOSOMA_CONNECTOR_SERVICE_URL: z.string().trim().url().refine(isServiceUrl).optional(),
  /** The token the server and the connector service share, instead of the generated one */
  RIOSOMA_CONNECTOR_SERVICE_TOKEN: z
    .string()
    .trim()
    .min(32)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  /** Where the generated token is kept, for a connector service that reads it from shared storage */
  RIOSOMA_CONNECTOR_SERVICE_TOKEN_FILE: z.string().trim().min(1).optional(),
  RIOSOMA_SECRET_KEY: z.string().optional(),
  RIOSOMA_CREDENTIAL_VAULTS: z.string().default('[]'),
  RIOSOMA_CREDENTIAL_CACHE_SECONDS: z.coerce.number().int().min(0).max(3600).default(300),
  RIOSOMA_CREDENTIAL_ROTATE: z.string().max(200).optional(),
  RIOSOMA_DATABASE_URL: z.string().optional(),
  RIOSOMA_DATABASE_PROFILE: z.string().optional(),
  RIOSOMA_SETUP_TOKEN: z
    .string()
    .min(16)
    .refine((value) => !/[^A-Za-z0-9_-]/.test(value))
    .optional(),
  RIOSOMA_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RIOSOMA_WEB_DIR: z.string().optional(),
  RIOSOMA_THEMES_DIR: z.string().optional(),
  /** Only explicitly configured proxies may supply forwarded client addresses. */
  RIOSOMA_TRUST_PROXY: z.string().default(''),
  /** Lets automations and outbound webhooks call loopback, private, and link-local addresses. */
  RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS: z.enum(['true', 'false']).default('false'),
  /** The most a file source downloads for one sync or preview, in megabytes (2 GB by default) */
  RIOSOMA_SOURCE_DUCKDB_ROOTS: z.string().default(''),
  RIOSOMA_SOURCE_FILE_MAX_MB: z.coerce.number().int().min(1).max(1_048_576).default(2_048),
  /** The MapLibre style map views draw with, or `off` to list their records' places instead */
  RIOSOMA_MAP_STYLE_URL: z
    .string()
    .trim()
    .refine((value) => value.toLowerCase() === 'off' || isMapStyleUrl(value))
    .default(DEFAULT_MAP_STYLE_URL),
  /** GitHub's API, for bug reports sent from feedback: GitHub's own unless a GitHub Enterprise server's */
  RIOSOMA_GITHUB_API_URL: z
    .string()
    .trim()
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    })
    .default(DEFAULT_GITHUB_API_URL),
  /** Bug relay destination, or off to prevent upstream reports regardless of organization settings. */
  RIOSOMA_HUB_URL: z
    .string()
    .trim()
    .refine((value) => value === 'off' || isServiceUrl(value))
    .default(DEFAULT_HUB_URL),
  /** Dropbox's app key and secret, for adding attachments from Dropbox */
  RIOSOMA_DROPBOX_APP_KEY: z.string().trim().min(1).optional(),
  RIOSOMA_DROPBOX_APP_SECRET: z.string().trim().min(1).optional(),
  /** GitHub's OAuth app, for reading connected app sources. */
  RIOSOMA_XERO_CLIENT_ID: z.string().trim().min(1).optional(),
  RIOSOMA_XERO_CLIENT_SECRET: z.string().trim().min(1).optional(),
  RIOSOMA_QUICKBOOKS_CLIENT_ID: z.string().trim().min(1).optional(),
  RIOSOMA_QUICKBOOKS_CLIENT_SECRET: z.string().trim().min(1).optional(),
  RIOSOMA_GITHUB_OAUTH_CLIENT_ID: z.string().trim().min(1).optional(),
  RIOSOMA_GITHUB_OAUTH_CLIENT_SECRET: z.string().trim().min(1).optional(),
  /** Box's client ID and secret, for adding attachments from Box */
  RIOSOMA_BOX_CLIENT_ID: z.string().trim().min(1).optional(),
  RIOSOMA_BOX_CLIENT_SECRET: z.string().trim().min(1).optional(),
  /** Google's OAuth client and the Picker's browser key, for adding attachments from Google Drive */
  RIOSOMA_GOOGLE_OAUTH_CLIENT_ID: z.string().trim().min(1).optional(),
  RIOSOMA_GOOGLE_OAUTH_CLIENT_SECRET: z.string().trim().min(1).optional(),
  RIOSOMA_GOOGLE_PICKER_API_KEY: z.string().trim().min(1).optional(),
  /** The Microsoft Entra app for Teams direct-message notifications. */
  RIOSOMA_MICROSOFT_TEAMS_TENANT_ID: z
    .string()
    .trim()
    .refine((value) => z.uuid().safeParse(value).success)
    .optional(),
  RIOSOMA_MICROSOFT_TEAMS_CLIENT_ID: z
    .string()
    .trim()
    .refine((value) => z.uuid().safeParse(value).success)
    .optional(),
  RIOSOMA_MICROSOFT_TEAMS_CLIENT_SECRET: z.string().trim().min(1).optional(),
  /** `off` stops update checks entirely, for servers with no way out to the internet */
  RIOSOMA_UPDATE_CHECKS: z.enum(['on', 'off']).default('on'),
  /** The signed feed of releases the server checks once a day */
  RIOSOMA_UPDATE_FEED_URL: z.string().trim().refine(isServiceUrl).default(DEFAULT_UPDATE_FEED_URL),
  /** For testing only: a JSON file of the keys a feed may be signed with, in place of this release's */
  RIOSOMA_UPDATE_FEED_KEYS_FILE: z.string().trim().min(1).optional(),
  /** `off` keeps anonymous usage counts off whatever the owner chose */
  RIOSOMA_TELEMETRY: z.enum(['on', 'off']).default('on'),
  /** Where anonymous usage counts go each week, once the owner turns them on */
  RIOSOMA_TELEMETRY_URL: z.string().trim().refine(isServiceUrl).default(DEFAULT_TELEMETRY_URL),
  /** The updater sidecar's address, for one-click updates with Docker Compose */
  RIOSOMA_UPDATER_URL: z.string().trim().refine(isServiceUrl).optional(),
  /** The secret the server and the updater sidecar share */
  RIOSOMA_UPDATER_TOKEN: z
    .string()
    .trim()
    .min(32)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  /** How this server was installed, which decides the update steps it shows, or `auto` to tell */
  RIOSOMA_INSTALL_METHOD: z
    .enum(['auto', 'compose', 'docker', 'helm', 'kubernetes', 'container-apps', 'ecs', 'cloud-run', 'source'])
    .default('auto'),
  NODE_ENV: z.string().default('production'),
});

export const DEFAULT_SCRIPT_LIMITS = Object.freeze({
  memoryBytes: EnvSchema.shape.RIOSOMA_AUTOMATIONS_SCRIPT_MEMORY_MB.parse(undefined) * 1024 * 1024,
  timeoutMs: EnvSchema.shape.RIOSOMA_AUTOMATIONS_SCRIPT_TIMEOUT_MS.parse(undefined),
  outputBytes: EnvSchema.shape.RIOSOMA_AUTOMATIONS_SCRIPT_OUTPUT_KB.parse(undefined) * 1024,
  logBytes: 64 * 1024,
});

export interface RuntimeConfig {
  demoMode: boolean;
  demoAccount?: string;
  demoLink?: string;
  demoAddressLimit: number;
  demoSessionLimit: number;
  databaseWaitSeconds?: number;
  scriptLimits?: { memoryBytes: number; timeoutMs: number; outputBytes: number; logBytes: number };
  /** How long all of one automation run's script steps may take together, five minutes when unset */
  automationScriptRunMs?: number;
  /** The script panel's time limit, the script's own time without waits for the person, 60 seconds when unset */
  scriptPanelTimeoutMs?: number;
  /** The longest one script panel run may take in all, waits included, 30 minutes when unset */
  scriptPanelRunMs?: number;
  providerApiKeys?: Record<string, string | undefined>;
  providerWorkspaceId?: string;
  /** The electricity zone AI footprint estimates use unless an organization picks its own, WOR when unset */
  aiElectricityZone?: string;
  searchUrl?: string;
  pdfRendererUrl?: string;
  port: number;
  host: string;
  baseUrl: string | undefined;
  tlsAskToken?: string;
  tlsAskAddresses?: string;
  customDomainTarget?: string;
  /** The most custom domains one organization may have added at once */
  customDomainLimit?: number;
  sessionIdleDays: number;
  sessionMaxDays: number;
  smtpUrl: string | undefined;
  smtpAllowPlaintext: boolean;
  dbQueryTimeoutMs: number;
  snapshotCacheMb?: number;
  /** Each statement a live table sends its source may run this long, 15 seconds when unset */
  liveTimeoutMs?: number;
  /** The most records a live table's view lists, 250,000 when unset */
  liveMaxKeys?: number;
  /** Submissions one address may make to one public form in an hour, 20 when unset */
  publicFormHourlyLimit?: number;
  /** Requests one address may make to shared view links in a minute, 600 when unset */
  sharedViewMinuteLimit?: number;
  /** Requests one token may make to the Airtable-compatible API in a second, 50 when unset */
  airtableApiSecondLimit?: number;
  /** Connections SQL editor queries run on, apart from the app's own pool, 3 when unset */
  sqlPoolMax?: number;
  /** Whether admins may give outside tools a PostgreSQL login, off when unset */
  sqlOutsideLogins?: boolean;
  /** Runs one person may start in the SQL editor in a minute, 30 when unset */
  sqlMinuteLimit?: number;
  /** Signature requests one person may send in an hour, 20 when unset */
  signatureRequestHourlyLimit?: number;
  /** Signers one person may add to signature requests in a day, 200 when unset */
  signatureSignerDailyLimit?: number;
  /** The largest signed PDF emailed as an attachment rather than a link, 20 MB when unset */
  signatureAttachmentBytes?: number;
  mailFrom: string | undefined;
  /** The mail transport other than SMTP, with the settings it needs, or null for SMTP */
  mail?: MailTransportSettings | null;
  clamavUrl?: string;
  clamavApprovedUrls?: string[];
  filesStorage?: StorageKind;
  filesDir?: string;
  /** Where organization exports and imports keep their working folders, when not the default */
  archiveWorkDir?: string;
  /** The S3-compatible bucket, when its settings are there, whether or not new files go to it */
  filesS3?: S3Settings | null;
  /** The Azure Blob Storage container, when its settings are there, whether or not new files go to it */
  filesAzure?: AzureSettings | null;
  /** How long a download's signed address from the store works, or 0 (the default) to serve downloads itself */
  filesSignedUrlSeconds?: number;
  configDir: string;
  driversDir?: string;
  driverInstalls?: boolean;
  /** Where the connector service answers, when the operator names it */
  connectorServiceUrl?: string;
  /** The token shared with the connector service, when the operator sets one */
  connectorServiceToken?: string;
  /** Where the generated token for the connector service is kept */
  connectorServiceTokenFile?: string;
  secretKey: Buffer;
  credentials?: CredentialSettings;
  credentialPollMs?: number;
  database: DatabaseProfile | null;
  /** True when the database came from the environment, so the wizard can't replace it. */
  databaseFromEnv: boolean;
  setupTokenFromEnv: string | undefined;
  logLevel: string;
  webDir: string | undefined;
  themesDir: string | undefined;
  trustProxy: string | false | ((address: string, hop: number) => boolean);
  production: boolean;
  /** Whether automations, outbound webhooks, and file sources may reach addresses outside the public internet */
  automationsAllowPrivateHosts?: boolean;
  /** The most a file source downloads for one call, in bytes, or 2 GB when unset */
  sourceFileMaxBytes?: number;
  sourceDuckDbRoots?: string[];
  /** How often the automation worker looks for work, in milliseconds.  At 0 it waits to be driven by hand. */
  automationsPollMs?: number;
  /** How often the webhook worker looks for work, in milliseconds.  At 0 it waits to be driven by hand. */
  webhooksPollMs?: number;
  /** How often the report worker looks for work, in milliseconds.  At 0 it waits to be driven by hand. */
  reportsPollMs?: number;
  /** How often the outbound sync worker looks for work, in milliseconds.  At 0 it waits to be driven by hand. */
  outboundSyncPollMs?: number;
  /** How often the AI field worker looks for work, in milliseconds.  At 0 it waits to be driven by hand. */
  aiFieldsPollMs?: number;
  /** How often the routine worker looks for work, in milliseconds.  At 0 it waits to be driven by hand. */
  routinesPollMs?: number;
  /** How often embedding indexes look for changes, in milliseconds.  At 0 they wait to be driven by hand. */
  embeddingsPollMs?: number;
  /** How often library documents look for an indexing job, in milliseconds.  At 0 they wait to be driven by hand. */
  libraryIndexPollMs?: number;
  /** The style map views draw with, or null when maps are off.  Unset, it's `DEFAULT_MAP_STYLE_URL`. */
  mapStyleUrl?: string | null;
  /** GitHub's API, for bug reports sent from feedback.  Unset, it's `DEFAULT_GITHUB_API_URL`. */
  githubApiUrl?: string;
  /** Upstream bug relay; null keeps it off regardless of organization settings. */
  hubUrl?: string | null;
  /** The most one file picked from a cloud drive may be, in bytes, the upload limit when unset */
  fileImportMaxBytes?: number;
  /** Each cloud drive's app from the server's settings, which wins over one saved in admin settings */
  oauthApps?: Partial<Record<string, OAuthAppSettings>>;
  /** The signed feed of releases, or null when update checks are off */
  updateFeedUrl?: string | null;
  /** The keys a feed may be signed with.  Unset, the ones this release carries. */
  updateFeedKeys?: readonly FeedKey[];
  /** Where usage counts go.  Unset, `DEFAULT_TELEMETRY_URL`. */
  telemetryUrl?: string;
  /** False when the server's settings keep usage counts off whatever the owner chose */
  telemetryAllowed?: boolean;
  /** The updater sidecar, when both its address and its token are set */
  updater?: { url: string; token: string } | null;
  /** How this server was installed.  Unset, `source`. */
  installMethod?: InstallMethod;
  /** How often update checks, update runs, and usage counts look for work.  At 0 they wait to be driven by hand. */
  updatesPollMs?: number;
}

/** A provider's app as the server's settings give it: any part may be missing. */
export interface OAuthAppSettings {
  clientId?: string | undefined;
  tenantId?: string | undefined;
  clientSecret?: string | undefined;
  apiKey?: string | undefined;
}

export interface StoredConfig {
  secretKey?: string;
  /** The address people use to reach this server, captured during setup when not configured. */
  baseUrl?: string;
  /** The database profile, sealed with the instance key because it can hold credentials. */
  database?: string;
  setupToken?: string;
}

const PROFILE_CONTEXT = 'riosoma.config.database';

/**
 * Settings whose names, once their underscores are gone, end in a word that marks a secret, or an
 * address that can carry one
 */
const SECRET_SETTING =
  /(SECRET|PASSWORD|PASSPHRASE|TOKEN|KEY|PEM|CREDENTIALS?|PROFILE|CONNECTIONSTRING|JSON|URL|VAULTS)$/;

/**
 * The values of the environment's secret settings, as they were written, for keeping out of what
 * an installed driver says.  It reads the environment here, where every other setting is read.
 */
export function secretSettingValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        value && name.startsWith('RIOSOMA_') && SECRET_SETTING.test(name.replaceAll('_', '')),
    )
    .map(([, value]) => value!);
}

export function readStored(dir: string): StoredConfig {
  const file = join(dir, 'riosoma.config.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StoredConfig;
  } catch {
    throw new ConfigurationError('riosoma.config.json');
  }
}

export function writeStored(dir: string, update: Partial<StoredConfig>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'riosoma.config.json');
  const next: Record<string, unknown> = { ...readStored(dir), ...update };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  const temporary = join(dir, `.riosoma.config.${randomBytes(16).toString('hex')}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  let closed = false;
  try {
    writeFileSync(fd, JSON.stringify(next, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
    renameSync(temporary, file);
    // Persist the directory entry as well as the file contents before reporting success.
    const directory = openSync(dir, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (!closed) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

const FeedKeyFile = z
  .array(z.object({ id: z.string().min(1).max(64), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }))
  .min(1)
  .max(20);

/**
 * The keys RIOSOMA_UPDATE_FEED_KEYS_FILE names, for testing updates with a feed signed by a key
 * the test made: a JSON list of `{ id, publicKey }`, the format of the updater's `feed-keys.json`.
 * A file that can't be read, or holds anything else, stops the server, so a test never runs with
 * keys it didn't mean.
 */
function readFeedKeys(file: string): FeedKey[] {
  try {
    const keys = FeedKeyFile.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (keys.success) return keys.data;
  } catch {
    // Unreadable, or not JSON: reported below like a file of the wrong shape.
  }
  throw new ConfigurationError('RIOSOMA_UPDATE_FEED_KEYS_FILE');
}

export function storeDatabaseProfile(dir: string, key: Buffer, profile: DatabaseProfile): void {
  writeStored(dir, { database: seal(key, JSON.stringify(profile), PROFILE_CONTEXT) });
}

export type ConfigWarning = { setting: string; messageKey: 'config.serviceLinkIgnored'; message: string };

function warnServiceLink(warning: ConfigWarning): void {
  console.warn(JSON.stringify({ level: 40, ...warning }));
}

function environmentValue(name: string, value: string | undefined, warn: (warning: ConfigWarning) => void) {
  if (!name.startsWith('RIOSOMA_')) return value;
  if (!value?.trim()) return undefined;
  const serviceAddress = /^RIOSOMA_(?:[A-Z0-9_]+_)?SERVICE_(?:HOST|PORT(?:_[A-Z0-9_]+)?)$/.test(name);
  const serviceLink =
    /^RIOSOMA_(?:[A-Z0-9_]+_)?PORT(?:_[0-9]+_(?:TCP|UDP)(?:_(?:ADDR|PORT|PROTO))?)?$/.test(name) &&
    /^(?:tcp|udp):\/\//.test(value);
  if (serviceAddress || serviceLink) {
    const messageKey = 'config.serviceLinkIgnored';
    warn({ setting: name, messageKey, message: startupMessage(messageKey) });
    return undefined;
  }
  return value;
}

/** Standalone utilities need settings without creating the server's stored configuration. */
export function configuredVersion(env: NodeJS.ProcessEnv = process.env): string {
  return EnvSchema.shape.RIOSOMA_VERSION.parse(
    environmentValue('RIOSOMA_VERSION', env.RIOSOMA_VERSION, warnServiceLink),
  );
}

export function smokeProfile(env: NodeJS.ProcessEnv = process.env): DatabaseProfile {
  return parseProfile(
    environmentValue('RIOSOMA_SMOKE_PROFILE', env.RIOSOMA_SMOKE_PROFILE, warnServiceLink) ?? 'null',
    'RIOSOMA_SMOKE_PROFILE',
  );
}

export function parseEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  warn: (warning: ConfigWarning) => void = warnServiceLink,
) {
  const normalized = Object.fromEntries(
    Object.entries(env).map(([name, value]) => [name, environmentValue(name, value, warn)]),
  );
  const parsed = EnvSchema.safeParse(normalized);
  if (!parsed.success) {
    const setting = parsed.error.issues[0]?.path[0];
    // Only known schema fields can be named in diagnostics; no rejected values are retained.
    const name = typeof setting === 'string' && setting in EnvSchema.shape ? setting : 'environment';
    throw new ConfigurationError(name, name === 'RIOSOMA_SETUP_TOKEN' ? 'setupToken' : 'invalid');
  }
  return parsed.data;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (warning: ConfigWarning) => void = warnServiceLink,
): RuntimeConfig {
  const e = parseEnvironment(env, warn);
  if (e.RIOSOMA_FILES_STORAGE === 'local' && !e.RIOSOMA_FILES_DIR)
    throw new ConfigurationError('RIOSOMA_FILES_DIR', 'requiredLocal');
  const filesS3 = s3Settings(e);
  const filesAzure = azureSettings(e);
  const stored = readStored(e.RIOSOMA_CONFIG_DIR);

  // The secret key seals stored credentials and signs cookies.  Generated once and kept in the
  // config directory unless the operator supplies one (which keeps it apart from the sealed data).
  let secret = e.RIOSOMA_SECRET_KEY ?? stored.secretKey;
  if (!secret) {
    secret = randomBytes(32).toString('base64');
    writeStored(e.RIOSOMA_CONFIG_DIR, { secretKey: secret });
  }
  const secretKey = Buffer.from(secret, 'base64');
  if (secretKey.length !== 32) throw new ConfigurationError('RIOSOMA_SECRET_KEY', 'secretKey');

  let database: DatabaseProfile | null = null;
  let databaseFromEnv = false;
  if (e.RIOSOMA_DATABASE_PROFILE) {
    database = parseProfile(e.RIOSOMA_DATABASE_PROFILE, 'RIOSOMA_DATABASE_PROFILE');
    databaseFromEnv = true;
  } else if (e.RIOSOMA_DATABASE_URL) {
    database = profileFromUrl(e.RIOSOMA_DATABASE_URL);
    databaseFromEnv = true;
  } else if (stored.database) {
    let json: string;
    try {
      json = unseal(secretKey, stored.database, PROFILE_CONTEXT);
    } catch {
      throw new ConfigurationError('riosoma.config.json', 'sealed');
    }
    database = parseProfile(json, 'riosoma.config.json');
  }

  return {
    databaseWaitSeconds: e.RIOSOMA_DATABASE_WAIT_SECONDS,
    scriptLimits: {
      memoryBytes: e.RIOSOMA_AUTOMATIONS_SCRIPT_MEMORY_MB * 1024 * 1024,
      timeoutMs: e.RIOSOMA_AUTOMATIONS_SCRIPT_TIMEOUT_MS,
      outputBytes: e.RIOSOMA_AUTOMATIONS_SCRIPT_OUTPUT_KB * 1024,
      logBytes: DEFAULT_SCRIPT_LIMITS.logBytes,
    },
    scriptPanelTimeoutMs: e.RIOSOMA_SCRIPTS_TIMEOUT_MS,
    ...providerKeysFrom(e),
    aiElectricityZone: e.RIOSOMA_AI_ELECTRICITY_ZONE.toUpperCase(),
    searchUrl: e.RIOSOMA_SEARCH_URL,
    pdfRendererUrl: e.RIOSOMA_PDF_RENDERER_URL,
    port: e.RIOSOMA_PORT,
    host: e.RIOSOMA_HOST,
    baseUrl: e.RIOSOMA_BASE_URL ?? stored.baseUrl,
    tlsAskToken: e.RIOSOMA_TLS_ASK_TOKEN,
    tlsAskAddresses: e.RIOSOMA_TLS_ASK_ADDRESSES,
    customDomainTarget: e.RIOSOMA_CUSTOM_DOMAIN_TARGET,
    customDomainLimit: e.RIOSOMA_CUSTOM_DOMAIN_LIMIT,
    demoMode: e.RIOSOMA_DEMO_MODE === 'on',
    demoAccount: e.RIOSOMA_DEMO_ACCOUNT,
    demoLink: e.RIOSOMA_DEMO_LINK,
    demoAddressLimit: e.RIOSOMA_DEMO_ADDRESS_LIMIT,
    demoSessionLimit: e.RIOSOMA_DEMO_SESSION_LIMIT,
    sessionIdleDays: e.RIOSOMA_SESSION_IDLE_DAYS,
    sessionMaxDays: e.RIOSOMA_SESSION_MAX_DAYS,
    smtpUrl: e.RIOSOMA_SMTP_URL,
    smtpAllowPlaintext: e.RIOSOMA_SMTP_ALLOW_PLAINTEXT === 'true',
    dbQueryTimeoutMs: e.RIOSOMA_DB_QUERY_TIMEOUT_MS,
    snapshotCacheMb: e.RIOSOMA_SNAPSHOT_CACHE_MB,
    liveTimeoutMs: e.RIOSOMA_LIVE_TIMEOUT_MS,
    liveMaxKeys: e.RIOSOMA_LIVE_MAX_KEYS,
    publicFormHourlyLimit: e.RIOSOMA_PUBLIC_FORM_HOURLY_LIMIT,
    sharedViewMinuteLimit: e.RIOSOMA_SHARED_VIEW_MINUTE_LIMIT,
    airtableApiSecondLimit: e.RIOSOMA_AIRTABLE_API_SECOND_LIMIT,
    sqlPoolMax: e.RIOSOMA_SQL_POOL_MAX,
    sqlOutsideLogins: e.RIOSOMA_SQL_OUTSIDE_LOGINS === 'on',
    signatureRequestHourlyLimit: e.RIOSOMA_SIGNATURE_REQUEST_HOURLY_LIMIT,
    signatureSignerDailyLimit: e.RIOSOMA_SIGNATURE_SIGNER_DAILY_LIMIT,
    mailFrom: e.RIOSOMA_MAIL_FROM,
    mail: mailTransport(e, env),
    clamavUrl: e.RIOSOMA_CLAMAV_URL,
    clamavApprovedUrls: e.RIOSOMA_CLAMAV_APPROVED_URLS?.split(',').map((address) => address.trim()),
    filesStorage: e.RIOSOMA_FILES_STORAGE,
    filesDir: e.RIOSOMA_FILES_DIR,
    archiveWorkDir: e.RIOSOMA_ARCHIVE_WORK_DIR,
    filesS3,
    filesAzure,
    filesSignedUrlSeconds: e.RIOSOMA_FILES_SIGNED_URL_SECONDS,
    configDir: e.RIOSOMA_CONFIG_DIR,
    driversDir: e.RIOSOMA_DRIVERS_DIR ?? join(e.RIOSOMA_CONFIG_DIR, 'drivers'),
    driverInstalls: e.RIOSOMA_DRIVER_INSTALLS === 'on',
    connectorServiceUrl: e.RIOSOMA_CONNECTOR_SERVICE_URL,
    connectorServiceToken: e.RIOSOMA_CONNECTOR_SERVICE_TOKEN,
    connectorServiceTokenFile:
      e.RIOSOMA_CONNECTOR_SERVICE_TOKEN_FILE ?? join(e.RIOSOMA_CONFIG_DIR, 'connector-service.token'),
    secretKey,
    credentials: {
      profiles: credentialProfiles(e.RIOSOMA_CREDENTIAL_VAULTS),
      cacheSeconds: e.RIOSOMA_CREDENTIAL_CACHE_SECONDS,
      rotateOnStartup: e.RIOSOMA_CREDENTIAL_ROTATE,
    },
    database,
    databaseFromEnv,
    setupTokenFromEnv: e.RIOSOMA_SETUP_TOKEN,
    logLevel: e.RIOSOMA_LOG_LEVEL,
    webDir: e.RIOSOMA_WEB_DIR,
    themesDir: e.RIOSOMA_THEMES_DIR,
    trustProxy: proxyTrust(e.RIOSOMA_TRUST_PROXY),
    production: e.NODE_ENV === 'production',
    automationsAllowPrivateHosts: e.RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS === 'true',
    sourceDuckDbRoots: e.RIOSOMA_SOURCE_DUCKDB_ROOTS.split(',')
      .map((path) => path.trim())
      .filter(Boolean),
    sourceFileMaxBytes: e.RIOSOMA_SOURCE_FILE_MAX_MB * 1024 * 1024,
    mapStyleUrl: e.RIOSOMA_MAP_STYLE_URL.toLowerCase() === 'off' ? null : e.RIOSOMA_MAP_STYLE_URL,
    githubApiUrl: e.RIOSOMA_GITHUB_API_URL.replace(/\/+$/, ''),
    hubUrl: e.RIOSOMA_HUB_URL === 'off' ? null : e.RIOSOMA_HUB_URL.replace(/\/+$/, ''),
    updateFeedUrl: e.RIOSOMA_UPDATE_CHECKS === 'off' ? null : e.RIOSOMA_UPDATE_FEED_URL,
    ...(e.RIOSOMA_UPDATE_FEED_KEYS_FILE
      ? { updateFeedKeys: readFeedKeys(e.RIOSOMA_UPDATE_FEED_KEYS_FILE) }
      : {}),
    telemetryUrl: e.RIOSOMA_TELEMETRY_URL,
    telemetryAllowed: e.RIOSOMA_TELEMETRY === 'on',
    updater:
      e.RIOSOMA_UPDATER_URL && e.RIOSOMA_UPDATER_TOKEN
        ? { url: e.RIOSOMA_UPDATER_URL.replace(/\/+$/, ''), token: e.RIOSOMA_UPDATER_TOKEN }
        : null,
    installMethod: installMethod(e.RIOSOMA_INSTALL_METHOD, env),
    oauthApps: {
      xero: { clientId: e.RIOSOMA_XERO_CLIENT_ID, clientSecret: e.RIOSOMA_XERO_CLIENT_SECRET },
      quickbooks: {
        clientId: e.RIOSOMA_QUICKBOOKS_CLIENT_ID,
        clientSecret: e.RIOSOMA_QUICKBOOKS_CLIENT_SECRET,
      },
      github: {
        clientId: e.RIOSOMA_GITHUB_OAUTH_CLIENT_ID,
        clientSecret: e.RIOSOMA_GITHUB_OAUTH_CLIENT_SECRET,
      },
      'microsoft-teams': {
        tenantId: e.RIOSOMA_MICROSOFT_TEAMS_TENANT_ID,
        clientId: e.RIOSOMA_MICROSOFT_TEAMS_CLIENT_ID,
        clientSecret: e.RIOSOMA_MICROSOFT_TEAMS_CLIENT_SECRET,
      },
      dropbox: { clientId: e.RIOSOMA_DROPBOX_APP_KEY, clientSecret: e.RIOSOMA_DROPBOX_APP_SECRET },
      box: { clientId: e.RIOSOMA_BOX_CLIENT_ID, clientSecret: e.RIOSOMA_BOX_CLIENT_SECRET },
      google: {
        clientId: e.RIOSOMA_GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: e.RIOSOMA_GOOGLE_OAUTH_CLIENT_SECRET,
        apiKey: e.RIOSOMA_GOOGLE_PICKER_API_KEY,
      },
    },
  };
}

type Environment = z.infer<typeof EnvSchema>;

/**
 * How the server was installed.  The Compose file and the Helm chart say so, and otherwise the
 * variables each platform sets for its containers tell, and a container with none of them was
 * started with plain Docker.  Nothing about the platform leaves the server.
 */
function installMethod(
  setting: Environment['RIOSOMA_INSTALL_METHOD'],
  env: NodeJS.ProcessEnv,
): InstallMethod {
  if (setting !== 'auto') return setting;
  if (env.KUBERNETES_SERVICE_HOST) return 'kubernetes';
  if (env.CONTAINER_APP_NAME) return 'container-apps';
  if (env.ECS_CONTAINER_METADATA_URI_V4 || env.ECS_CONTAINER_METADATA_URI) return 'ecs';
  if (env.K_SERVICE) return 'cloud-run';
  return existsSync('/.dockerenv') ? 'docker' : 'source';
}

/**
 * The AWS variables a role's keys are read from, captured here rather than at send time, since the
 * server reads its environment in this module alone.  A task's or instance's role needs no setting
 * of Riosoma's own: the platform puts these in the environment.
 */
const AWS_ROLE_SETTINGS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
] as const;

function awsRoleEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    AWS_ROLE_SETTINGS.filter((name) => env[name]?.trim()).map((name) => [name, env[name]!.trim()]),
  );
}

/**
 * The mail transport's own settings, checked as the settings are read, so a server that was asked
 * to send through a service starts only with everything that service needs.
 */
function mailTransport(e: Environment, env: NodeJS.ProcessEnv): MailTransportSettings | null {
  return mailSettings(e.RIOSOMA_MAIL_TRANSPORT, {
    from: e.RIOSOMA_MAIL_FROM,
    awsEnvironment: awsRoleEnvironment(env),
    sesRegion: e.RIOSOMA_SES_REGION,
    sesAccessKeyId: e.RIOSOMA_SES_ACCESS_KEY_ID,
    sesSecretAccessKey: e.RIOSOMA_SES_SECRET_ACCESS_KEY,
    acsConnectionString: e.RIOSOMA_ACS_CONNECTION_STRING,
    acsEndpoint: e.RIOSOMA_ACS_ENDPOINT,
    graphTenantId: e.RIOSOMA_GRAPH_TENANT_ID,
    graphClientId: e.RIOSOMA_GRAPH_CLIENT_ID,
    graphClientSecret: e.RIOSOMA_GRAPH_CLIENT_SECRET,
    graphSender: e.RIOSOMA_GRAPH_SENDER,
    gmailServiceAccountJson: e.RIOSOMA_GMAIL_SERVICE_ACCOUNT_JSON,
    gmailSender: e.RIOSOMA_GMAIL_SENDER,
    relayUrl: e.RIOSOMA_MAIL_RELAY_URL,
    relaySecret: e.RIOSOMA_MAIL_RELAY_SECRET,
  });
}

/** A folder prefix that ends in one slash, or nothing. */
function folder(prefix: string | undefined): string {
  return prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
}

/**
 * The S3-compatible bucket's settings, when new files go there or its bucket is named, which it
 * has to be while files stored there earlier are still read from it.
 */
function s3Settings(e: Environment): S3Settings | null {
  if (e.RIOSOMA_FILES_STORAGE !== 's3' && !e.RIOSOMA_FILES_S3_BUCKET) return null;
  for (const setting of [
    'RIOSOMA_FILES_S3_BUCKET',
    'RIOSOMA_FILES_S3_ACCESS_KEY_ID',
    'RIOSOMA_FILES_S3_SECRET_ACCESS_KEY',
  ] as const)
    if (!e[setting]) throw new ConfigurationError(setting, 'requiredS3');
  if (!e.RIOSOMA_FILES_S3_ENDPOINT && !e.RIOSOMA_FILES_S3_REGION)
    throw new ConfigurationError('RIOSOMA_FILES_S3_REGION', 'requiredS3Place');
  if (e.RIOSOMA_FILES_S3_KMS_KEY_ID && e.RIOSOMA_FILES_S3_SSE !== 'aws:kms')
    throw new ConfigurationError('RIOSOMA_FILES_S3_KMS_KEY_ID', 'kmsKey');
  return {
    ...(e.RIOSOMA_FILES_S3_ENDPOINT ? { endpoint: e.RIOSOMA_FILES_S3_ENDPOINT } : {}),
    ...(e.RIOSOMA_FILES_S3_REGION ? { region: e.RIOSOMA_FILES_S3_REGION } : {}),
    bucket: e.RIOSOMA_FILES_S3_BUCKET!,
    prefix: folder(e.RIOSOMA_FILES_S3_PREFIX),
    accessKeyId: e.RIOSOMA_FILES_S3_ACCESS_KEY_ID!,
    secretAccessKey: e.RIOSOMA_FILES_S3_SECRET_ACCESS_KEY!,
    pathStyle: e.RIOSOMA_FILES_S3_PATH_STYLE === 'true',
    ...(e.RIOSOMA_FILES_S3_SSE ? { serverSideEncryption: e.RIOSOMA_FILES_S3_SSE } : {}),
    ...(e.RIOSOMA_FILES_S3_KMS_KEY_ID ? { kmsKeyId: e.RIOSOMA_FILES_S3_KMS_KEY_ID } : {}),
  };
}

/**
 * The Azure Blob Storage container's settings, when new files go there or its account is named.
 * With no account key, requests use the server's managed identity, or its AKS workload identity.
 */
function azureSettings(e: Environment): AzureSettings | null {
  if (e.RIOSOMA_FILES_STORAGE !== 'azure-blob' && !e.RIOSOMA_FILES_AZURE_ACCOUNT) return null;
  for (const setting of ['RIOSOMA_FILES_AZURE_ACCOUNT', 'RIOSOMA_FILES_AZURE_CONTAINER'] as const)
    if (!e[setting]) throw new ConfigurationError(setting, 'requiredAzure');
  const account = e.RIOSOMA_FILES_AZURE_ACCOUNT!;
  return {
    account,
    container: e.RIOSOMA_FILES_AZURE_CONTAINER!,
    prefix: folder(e.RIOSOMA_FILES_AZURE_PREFIX),
    endpoint: e.RIOSOMA_FILES_AZURE_ENDPOINT ?? `https://${account}.blob.core.windows.net`,
    ...(e.RIOSOMA_FILES_AZURE_ACCOUNT_KEY ? { accountKey: e.RIOSOMA_FILES_AZURE_ACCOUNT_KEY } : {}),
    ...(e.RIOSOMA_FILES_AZURE_CLIENT_ID ? { clientId: e.RIOSOMA_FILES_AZURE_CLIENT_ID } : {}),
  };
}

function parseProfile(json: string, setting: string): DatabaseProfile {
  let profile: DatabaseProfile;
  try {
    profile = DatabaseProfile.parse(JSON.parse(json));
  } catch {
    throw new ConfigurationError(setting);
  }
  return profile;
}

function proxyTrust(value: string): RuntimeConfig['trustProxy'] {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!/^\d+$/.test(trimmed)) return trimmed;
  const hops = Number(trimmed);
  if (!Number.isSafeInteger(hops)) throw new ConfigurationError('RIOSOMA_TRUST_PROXY');
  // Explicit hop counts are operator policy, including installations without fixed proxy IPs.
  return (_address, hop) => hop < hops;
}

function credentialProfiles(value: string) {
  try {
    return VaultProfiles.parse(JSON.parse(value));
  } catch {
    throw new ConfigurationError('RIOSOMA_CREDENTIAL_VAULTS');
  }
}

/**
 * The part of this process's environment a process the server starts may see, such as the
 * connector service from a source checkout: the system's paths, language, time zone, certificate
 * and proxy settings, and the log level and version, but no other Riosoma setting.
 */
export function childProcessEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept =
    /^(PATH|HOME|USER|TMPDIR|TEMP|TMP|TZ|LANG|LC_\w+|NODE_ENV|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SYSTEMROOT|RIOSOMA_LOG_LEVEL|RIOSOMA_VERSION)$/;
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (kept.test(name)) out[name] = value;
  return out;
}
