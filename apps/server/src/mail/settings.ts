import { ConfigurationError } from '../configuration-error.js';

/**
 * What each transport needs to start, read from the settings and checked here so the server stops
 * with the setting's own name rather than failing on the first message.  Every transport sends as
 * `RIOSOMA_MAIL_FROM`, and each one reads the rest from settings of its own.
 */

/** The transports email can go out through, chosen by `RIOSOMA_MAIL_TRANSPORT`. */
export type MailTransportKind = 'smtp' | 'ses' | 'acs' | 'graph' | 'gmail' | 'relay';

export interface SesSettings {
  /** The sender on every message, from `RIOSOMA_MAIL_FROM` */
  from: string;
  /** The region requests are signed for, such as `eu-west-1` */
  region: string;
  /** Both keys, or neither: without them the instance's or task's own role signs */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** The AWS variables a role's keys are read from, captured when the settings were read */
  roleEnvironment?: NodeJS.ProcessEnv;
}

export interface AcsSettings {
  from: string;
  /** The email service's address with no path, such as `https://<resource>.<region>.communication.azure.com` */
  endpoint: string;
  /** The access key, base64, or absent to sign in with the server's managed identity */
  accessKey?: string;
}

export interface GraphSettings {
  from: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The mailbox that sends, whose address the app's `Mail.Send` permission covers */
  sender: string;
}

export interface GmailSettings {
  from: string;
  /** The service account's key file, as the JSON Google hands out */
  serviceAccountJson: string;
  /** The mailbox that sends, which the service account may act for */
  sender: string;
}

export interface RelaySettings {
  from: string;
  /** Where each message is posted, as JSON */
  url: string;
  /** The key each post is signed with */
  secret: string;
}

/** The chosen transport's own settings, with its kind, or null for SMTP. */
export type MailTransportSettings =
  | ({ kind: 'ses' } & SesSettings)
  | ({ kind: 'acs' } & AcsSettings)
  | ({ kind: 'graph' } & GraphSettings)
  | ({ kind: 'gmail' } & GmailSettings)
  | ({ kind: 'relay' } & RelaySettings);

/** The settings a transport reads, as the environment gives them, with nothing checked yet. */
export interface MailSettingValues {
  from?: string | undefined;
  /** The AWS environment a role's keys come from, which only SES reads */
  awsEnvironment?: NodeJS.ProcessEnv | undefined;
  sesRegion?: string | undefined;
  sesAccessKeyId?: string | undefined;
  sesSecretAccessKey?: string | undefined;
  acsConnectionString?: string | undefined;
  acsEndpoint?: string | undefined;
  graphTenantId?: string | undefined;
  graphClientId?: string | undefined;
  graphClientSecret?: string | undefined;
  graphSender?: string | undefined;
  gmailServiceAccountJson?: string | undefined;
  gmailSender?: string | undefined;
  relayUrl?: string | undefined;
  relaySecret?: string | undefined;
}

/** A setting the chosen transport got in a shape it can't use, and what's wrong with it. */
function unusable(setting: string, detail: string): never {
  throw new ConfigurationError(setting, 'invalid', detail);
}

/** A setting the chosen transport needs and didn't get, named with the transport that needs it. */
function missing(setting: string, kind: MailTransportKind): never {
  throw new ConfigurationError(setting, 'requiredMail', kind);
}

function required(value: string | undefined, setting: string, kind: MailTransportKind): string {
  if (!value?.trim()) missing(setting, kind);
  return value!.trim();
}

/**
 * The email service's address as a call starts from it: `https`, with no credentials, path, query,
 * or fragment, since a key or a managed identity token goes wherever it points.
 */
function acsEndpoint(value: string, setting: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    unusable(setting, 'must be the https address of the resource with no path');
  return url!.origin;
}

/**
 * An Azure Communication Services connection string's parts, read by name so anything the server
 * doesn't use is left alone: `accesskey=<base64>;endpoint=https://<resource>.communication.azure.com/`.
 */
export function acsConnectionString(value: string): { endpoint?: string; accessKey?: string } {
  const parts: Record<string, string> = {};
  for (const piece of value.split(';')) {
    const split = piece.indexOf('=');
    if (split < 1) continue;
    parts[piece.slice(0, split).trim().toLowerCase()] = piece.slice(split + 1).trim();
  }
  if (!parts.endpoint) unusable('RIOSOMA_ACS_CONNECTION_STRING', 'names no endpoint');
  if (!parts.accesskey) unusable('RIOSOMA_ACS_CONNECTION_STRING', 'names no accesskey');
  // The key signs as the bytes its base64 stands for, so one that isn't base64 could never sign.
  const key = Buffer.from(parts.accesskey, 'base64');
  if (!key.length || key.toString('base64').replace(/=+$/, '') !== parts.accesskey.replace(/=+$/, ''))
    unusable('RIOSOMA_ACS_CONNECTION_STRING', 'holds an accesskey that is not base64');
  return { endpoint: parts.endpoint, accessKey: parts.accesskey };
}

/** The transport's settings, or null for SMTP, which reads `RIOSOMA_SMTP_URL` itself. */
export function mailSettings(
  kind: MailTransportKind,
  values: MailSettingValues,
): MailTransportSettings | null {
  if (kind === 'smtp') return null;
  const from = required(values.from, 'RIOSOMA_MAIL_FROM', kind);
  switch (kind) {
    case 'ses': {
      const region = required(values.sesRegion, 'RIOSOMA_SES_REGION', kind);
      const accessKeyId = values.sesAccessKeyId?.trim();
      const secretAccessKey = values.sesSecretAccessKey?.trim();
      if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
        unusable(
          accessKeyId ? 'RIOSOMA_SES_SECRET_ACCESS_KEY' : 'RIOSOMA_SES_ACCESS_KEY_ID',
          'both keys are needed to sign with one',
        );
      return {
        kind,
        from,
        region,
        ...(accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : {}),
        ...(values.awsEnvironment ? { roleEnvironment: values.awsEnvironment } : {}),
      };
    }
    case 'acs': {
      const connection = values.acsConnectionString?.trim()
        ? acsConnectionString(values.acsConnectionString)
        : {};
      // An endpoint of its own wins over the connection string's.
      const endpoint = values.acsEndpoint?.trim()
        ? acsEndpoint(values.acsEndpoint, 'RIOSOMA_ACS_ENDPOINT')
        : connection.endpoint
          ? acsEndpoint(connection.endpoint, 'RIOSOMA_ACS_CONNECTION_STRING')
          : missing('RIOSOMA_ACS_ENDPOINT', kind);
      return {
        kind,
        from,
        endpoint,
        ...(connection.accessKey ? { accessKey: connection.accessKey } : {}),
      };
    }
    case 'graph':
      return {
        kind,
        from,
        tenantId: required(values.graphTenantId, 'RIOSOMA_GRAPH_TENANT_ID', kind),
        clientId: required(values.graphClientId, 'RIOSOMA_GRAPH_CLIENT_ID', kind),
        clientSecret: required(values.graphClientSecret, 'RIOSOMA_GRAPH_CLIENT_SECRET', kind),
        sender: required(values.graphSender, 'RIOSOMA_GRAPH_SENDER', kind),
      };
    case 'gmail':
      return {
        kind,
        from,
        serviceAccountJson: required(
          values.gmailServiceAccountJson,
          'RIOSOMA_GMAIL_SERVICE_ACCOUNT_JSON',
          kind,
        ),
        sender: required(values.gmailSender, 'RIOSOMA_GMAIL_SENDER', kind),
      };
    case 'relay':
      return {
        kind,
        from,
        url: required(values.relayUrl, 'RIOSOMA_MAIL_RELAY_URL', kind),
        secret: required(values.relaySecret, 'RIOSOMA_MAIL_RELAY_SECRET', kind),
      };
  }
}
