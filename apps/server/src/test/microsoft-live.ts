/**
 * What the Microsoft 365 live suites share: the test tenant's app, read from the environment, and
 * plain requests to Microsoft Graph and Dataverse as that app, for the suites' own setup and
 * cleanup.  The sources and the mail transport under test never use these: they sign in on their
 * own, the way they do on a server.
 *
 * Each suite runs only when its settings are set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_M365_TENANT_ID`, `RIOSOMA_TEST_M365_CLIENT_ID`, and
 *   `RIOSOMA_TEST_M365_CLIENT_SECRET`: the test app, which every suite needs
 * - `RIOSOMA_TEST_M365_MAILBOX`: a licensed mailbox in the tenant, which Graph mail sends from and
 *   to, and which owns the team the Teams suite makes
 * - `RIOSOMA_TEST_TEAMS_WEBHOOK_URL`: a Workflows webhook posting to a channel of that team
 * - `RIOSOMA_TEST_SHAREPOINT_SITE`: a site the app may manage lists and files in, like the team's
 * - `RIOSOMA_TEST_DATAVERSE_URL`: an environment the app is an application user of
 */

export interface MicrosoftLive {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

const value = (name: string) => process.env[name]?.trim() || undefined;

/** The test app, or undefined when any of its settings is missing. */
export function liveApp(): MicrosoftLive | undefined {
  const tenantId = value('RIOSOMA_TEST_M365_TENANT_ID');
  const clientId = value('RIOSOMA_TEST_M365_CLIENT_ID');
  const clientSecret = value('RIOSOMA_TEST_M365_CLIENT_SECRET');
  return tenantId && clientId && clientSecret ? { tenantId, clientId, clientSecret } : undefined;
}

export const liveMailbox = () => value('RIOSOMA_TEST_M365_MAILBOX');
export const liveTeamsWebhook = () => value('RIOSOMA_TEST_TEAMS_WEBHOOK_URL');
export const liveSite = () => value('RIOSOMA_TEST_SHAREPOINT_SITE');
export const liveDataverse = () => value('RIOSOMA_TEST_DATAVERSE_URL');

/** The name every object a suite makes starts with, so a stray one is easy to find and remove. */
export const TEST_PREFIX = 'rio_test_';

/** An app-only token for a service's `/.default` scope, like `https://graph.microsoft.com`. */
export async function liveToken(
  app: MicrosoftLive,
  resource = 'https://graph.microsoft.com',
): Promise<string> {
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(app.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        scope: `${resource}/.default`,
        grant_type: 'client_credentials',
      }),
    },
  );
  const answer = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!answer.access_token)
    throw new Error(
      `Entra gave no token for ${resource}: ${answer.error ?? response.status} ${answer.error_description?.split('\n')[0] ?? ''}`,
    );
  return answer.access_token;
}

export interface LiveAnswer {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
  text: string;
}

/** One request with a token, answered with its status, headers, and JSON (empty when it has none). */
export async function liveRequest(
  token: string,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<LiveAnswer> {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined
      ? {}
      : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Some answers, like a file's content, aren't JSON.
  }
  return { status: response.status, headers: response.headers, json, text };
}

/** Waits `ms`, for services that finish their work a moment after they answer. */
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Asks `check` until it gives a value, or gives up after `ms`. */
export async function eventually<T>(
  check: () => Promise<T | undefined>,
  ms: number,
  every = 3_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Error(`gave up waiting after ${ms} ms`);
    await pause(every);
  }
}
