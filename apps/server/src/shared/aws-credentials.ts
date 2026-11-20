import { readFileSync } from 'node:fs';

/**
 * The AWS keys a request is signed with, found the way every AWS SDK finds them: in the
 * environment, then at the container credentials endpoint a task is handed, then on the instance's
 * own metadata service.  A role's keys are short-lived, so what this hands back is a function that
 * refreshes them before they expire rather than a fixed pair.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** A role's session token, which a signed request carries with it */
  sessionToken?: string;
  /** When the keys stop working, in milliseconds since the epoch, or absent when they don't */
  expiresAt?: number;
}

/** A call that answers with keys to sign with, fetching them again once they near their end. */
export type AwsCredentialSource = () => Promise<AwsCredentials>;

export interface AwsCredentialOptions {
  /**
   * The environment the chain reads.  It's passed in rather than read here, since the server reads
   * its environment in its configuration module alone.  Empty, the chain goes to the endpoints.
   */
  env?: NodeJS.ProcessEnv;
  /** The client the container and metadata requests go through, which tests replace */
  fetch?: typeof fetch;
  /** Replaces the container credentials endpoint's base address, for a test */
  containerUrl?: string;
  /** Replaces the instance metadata address, for a test */
  metadataUrl?: string;
  /** The clock in milliseconds since the epoch, for a test */
  now?: () => number;
  /** Milliseconds each request gets: both endpoints sit on the machine itself, so this stays short */
  timeoutMs?: number;
}

/** Where a task's credentials come from, and where an instance's do. */
export const CONTAINER_CREDENTIALS_URL = 'http://169.254.170.2';
export const METADATA_URL = 'http://169.254.169.254';

/** How long a metadata token is asked for, which is the most the service gives. */
const METADATA_TOKEN_SECONDS = 21_600;

/** Keys are refreshed this long before they expire, so a request never carries dead ones. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * A failure to find keys, or to read them from where they were expected.  It names the settings and
 * endpoints it looked at and never carries a value from any of them.
 */
export class AwsCredentialsError extends Error {
  /** Where the chain looked and what it found there, in words that carry no value from anywhere */
  readonly reason: string;
  constructor(reason: string) {
    super(`No AWS credentials to sign with: ${reason}`);
    this.name = 'AwsCredentialsError';
    this.reason = reason;
  }
}

/** The keys named in the settings, which win over everything the environment offers. */
function configuredKeys(
  explicit: Pick<AwsCredentials, 'accessKeyId' | 'secretAccessKey'>,
): AwsCredentials | null {
  if (!explicit.accessKeyId || !explicit.secretAccessKey) return null;
  return { accessKeyId: explicit.accessKeyId, secretAccessKey: explicit.secretAccessKey };
}

/** The standard AWS environment variables, which a container or a shell sets for one job. */
function environmentKeys(env: NodeJS.ProcessEnv): AwsCredentials | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = env.AWS_SESSION_TOKEN?.trim();
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/**
 * The link-local addresses AWS serves container credentials from over plain HTTP: ECS's, and the
 * EKS Pod Identity agent's in IPv4 and IPv6.  They never leave the host, which is why the SDKs allow
 * them, as they do this machine's own loopback.
 */
const CONTAINER_HOSTS = new Set(['169.254.170.2', '169.254.170.23', 'fd00:ec2::23']);

/** Whether plain HTTP credentials may be read from a host: this machine, or AWS's own agents. */
function plainHttpAllowed(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    bare === '127.0.0.1' ||
    bare.startsWith('127.') ||
    CONTAINER_HOSTS.has(bare)
  );
}

interface Answer {
  status: number;
  text: string;
}

/** The two places keys are asked for, by the names the errors give them. */
const CONTAINER = 'the container credentials endpoint';
const METADATA = 'the instance metadata service';

async function request(
  place: string,
  url: string,
  method: 'GET' | 'PUT',
  headers: Record<string, string>,
  options: AwsCredentialOptions,
): Promise<Answer> {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  try {
    const response = await send(url, {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    return { status: response.status, text: await response.text() };
  } catch {
    // A server off AWS has no metadata service, so this is the usual answer there, not a fault.
    throw new AwsCredentialsError(`${place} could not be reached`);
  }
}

/** The keys in an endpoint's JSON answer, which both the container and the metadata service give. */
function keysOf(answer: Answer, place: string, now: number): AwsCredentials {
  if (answer.status !== 200) throw new AwsCredentialsError(`${place} answered HTTP ${answer.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    throw new AwsCredentialsError(`${place} answered something that isn't JSON`);
  }
  const value = parsed as Record<string, unknown>;
  const accessKeyId = typeof value.AccessKeyId === 'string' ? value.AccessKeyId : '';
  const secretAccessKey = typeof value.SecretAccessKey === 'string' ? value.SecretAccessKey : '';
  if (!accessKeyId || !secretAccessKey) throw new AwsCredentialsError(`${place} answered without keys`);
  const sessionToken = typeof value.Token === 'string' && value.Token ? value.Token : undefined;
  const expiration = typeof value.Expiration === 'string' ? Date.parse(value.Expiration) : Number.NaN;
  const expiresAt = Number.isFinite(expiration) ? expiration : undefined;
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    // An answer with no expiry, or one already past, is treated as expiring now so it's fetched again.
    expiresAt: expiresAt && expiresAt > now ? expiresAt : now + 1_000,
  };
}

/** The token in the file the platform names, or a failure that names the setting and not the path. */
function tokenFrom(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    throw new AwsCredentialsError('AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE could not be read');
  }
}

/** A task's own credentials, from the endpoint and token its platform sets in its environment. */
async function containerKeys(
  env: NodeJS.ProcessEnv,
  options: AwsCredentialOptions,
  now: number,
): Promise<AwsCredentials | null> {
  const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim();
  if (!relative && !full) return null;
  // The relative address wins, as it does in the AWS SDKs, and the full one is read only without it.
  if (!relative && !URL.canParse(full!))
    throw new AwsCredentialsError('AWS_CONTAINER_CREDENTIALS_FULL_URI is not an address');
  const url = relative
    ? new URL(relative, options.containerUrl ?? CONTAINER_CREDENTIALS_URL)
    : new URL(full!);
  // A full address may be plain HTTP only on this machine or an AWS agent's link-local address, so
  // a variable can't point keys anywhere else.
  if (url.protocol !== 'https:' && !plainHttpAllowed(url.hostname))
    throw new AwsCredentialsError(
      'AWS_CONTAINER_CREDENTIALS_FULL_URI must be https away from this machine and the AWS agents',
    );
  // The file wins, as it does in the AWS SDKs, since the agent rotates the token it holds.
  const tokenFile = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE?.trim();
  const token = tokenFile ? tokenFrom(tokenFile) : env.AWS_CONTAINER_AUTHORIZATION_TOKEN?.trim();
  const answer = await request(
    CONTAINER,
    url.href,
    'GET',
    token ? { accept: 'application/json', authorization: token } : { accept: 'application/json' },
    options,
  );
  return keysOf(answer, CONTAINER, now);
}

/** A metadata token, which IMDSv2 asks for first and every later request carries. */
async function metadataToken(base: string, options: AwsCredentialOptions): Promise<string> {
  const answer = await request(
    METADATA,
    `${base}/latest/api/token`,
    'PUT',
    { 'x-aws-ec2-metadata-token-ttl-seconds': String(METADATA_TOKEN_SECONDS) },
    options,
  );
  if (answer.status !== 200 || !answer.text.trim())
    throw new AwsCredentialsError(`the instance metadata service answered HTTP ${answer.status} for a token`);
  return answer.text.trim();
}

/** The instance's role keys, from IMDSv2, unless the environment turns the service off. */
async function instanceKeys(
  env: NodeJS.ProcessEnv,
  options: AwsCredentialOptions,
  now: number,
): Promise<AwsCredentials | null> {
  if (/^true$/i.test(env.AWS_EC2_METADATA_DISABLED?.trim() ?? '')) return null;
  const base = (options.metadataUrl ?? env.AWS_EC2_METADATA_SERVICE_ENDPOINT?.trim() ?? METADATA_URL).replace(
    /\/+$/,
    '',
  );
  const token = await metadataToken(base, options);
  const headers = { 'x-aws-ec2-metadata-token': token };
  const roles = await request(
    METADATA,
    `${base}/latest/meta-data/iam/security-credentials/`,
    'GET',
    headers,
    options,
  );
  if (roles.status !== 200)
    throw new AwsCredentialsError(
      `the instance metadata service answered HTTP ${roles.status} for its roles`,
    );
  const role = roles.text.trim().split('\n')[0]?.trim();
  if (!role) throw new AwsCredentialsError('the instance has no role attached');
  const answer = await request(
    METADATA,
    `${base}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`,
    'GET',
    headers,
    options,
  );
  return keysOf(answer, METADATA, now);
}

/**
 * Keys to sign AWS requests with.  `explicit` are the ones the server's own settings name, and they
 * win.  Without them the environment is read, then the task's credentials endpoint, then the
 * instance's metadata service.  What comes back is a function, since role keys expire and are
 * fetched again while the server runs.
 */
export function awsCredentials(
  explicit: Partial<Pick<AwsCredentials, 'accessKeyId' | 'secretAccessKey'>> = {},
  options: AwsCredentialOptions = {},
): AwsCredentialSource {
  const env = options.env ?? {};
  const now = options.now ?? Date.now;
  const fixed = configuredKeys({
    accessKeyId: explicit.accessKeyId ?? '',
    secretAccessKey: explicit.secretAccessKey ?? '',
  });
  let current: AwsCredentials | null = null;
  let pending: Promise<AwsCredentials> | null = null;

  async function find(): Promise<AwsCredentials> {
    if (fixed) return fixed;
    const moment = now();
    const fromEnvironment = environmentKeys(env);
    if (fromEnvironment) return fromEnvironment;
    const fromContainer = await containerKeys(env, options, moment);
    if (fromContainer) return fromContainer;
    const fromInstance = await instanceKeys(env, options, moment);
    if (fromInstance) return fromInstance;
    throw new AwsCredentialsError(
      'set the access key and secret, run as a task or instance with a role, or put AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment',
    );
  }

  return async () => {
    if (current && (!current.expiresAt || current.expiresAt - REFRESH_MARGIN_MS > now())) return current;
    // One fetch at a time, so a burst of messages asks for keys once rather than once each.
    pending ??= find()
      .then((found) => {
        current = found;
        return found;
      })
      .finally(() => {
        pending = null;
      });
    return await pending;
  };
}
