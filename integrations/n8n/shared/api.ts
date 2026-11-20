import type {
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestMethods,
  IHttpRequestOptions,
  ILoadOptionsFunctions,
  INode,
  IWebhookFunctions,
  JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import type { ApiErrorBody } from './types';

/** The credential both nodes use. */
export const CREDENTIALS = 'riosomaApi';

export type RiosomaContext = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IWebhookFunctions;

export interface RiosomaCredentials {
  url: string;
  token: string;
  ignoreSslIssues?: boolean;
}

/** The server's address as people paste it, without a trailing slash or the API's path. */
export function serverAddress(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/, '');
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

/** A query string that repeats a key for each value in a list, as the REST API reads lists. */
export function queryString(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  return params.toString();
}

const SCOPES: Record<string, string> = {
  'schema.bases:read': 'Read tables, fields, and views',
  'data.records:read': 'Read records',
  'data.records:write': 'Add, change, and delete records',
  'schema.bases:write': 'Change tables, fields, and views',
};

/** The token scope a request needs, from its method and path. */
export function scopeFor(method: string, path: string): string {
  if (path.includes('/webhooks')) return 'schema.bases:write';
  if (path.startsWith('/tables/')) return method === 'GET' ? 'data.records:read' : 'data.records:write';
  return 'schema.bases:read';
}

function hintFor(key: string, method: string, path: string): string | null {
  const scope = scopeFor(method, path);
  switch (key) {
    case 'errors.tokenInvalid':
      return 'Check the token in the Riosoma credential.  It may be mistyped, expired, or revoked.  To make a new one, open Riosoma and choose Settings, then Personal access tokens.';
    case 'errors.tokenScope':
      return `This needs a token with the "${SCOPES[scope]}" scope (${scope}).  A token's scopes can't change, so create one that includes it.`;
    case 'errors.tokenDatabase':
      return 'The token is limited to other databases.  Create one for all databases, or one that includes this database.';
    case 'errors.notFound':
      return "It may have been deleted, or the token can't reach it.  Riosoma answers not found for anything outside the token's databases or your role.";
    case 'data.access.denied':
      return path.includes('/webhooks')
        ? 'Managing webhooks takes the Creator or Owner role in the database.'
        : 'Writing records takes the Editor, Creator, or Owner role in the database, and a field or record can be locked for you.';
    case 'data.field.unknown':
      return 'Check the field names against the table.  A field hidden from you counts as missing.';
    case 'data.value.unknownChoice':
      return 'Use an existing option, or turn on Typecast to add it.  Adding options takes the Creator or Owner role.';
    case 'data.value.computed':
      return 'Riosoma fills in this field itself, so leave it out of the values.';
    case 'api.cursor.invalid':
      return 'Riosoma keeps the pages of a read for a limited time, and this one expired.  Run the node again.';
    case 'webhooks.url.https':
      return "Riosoma sends webhooks only to https addresses.  Set n8n's N8N_WEBHOOK_URL environment variable, or WEBHOOK_URL before n8n 2, to its https address.";
    case 'webhooks.url.private':
      return "The address is on a private network.  Riosoma's operator can allow that by setting RIOSOMA_AUTOMATIONS_ALLOW_PRIVATE_HOSTS=true.";
    case 'webhooks.limit':
      return 'Remove a webhook the database no longer needs, in Riosoma under Webhooks.';
    default:
      return null;
  }
}

function describeParams(params: Record<string, unknown> | undefined): string | null {
  if (!params) return null;
  const parts = Object.entries(params).map(([key, value]) => {
    const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
    const label = key === 'field' ? 'Field' : key === 'value' ? 'Value' : key === 'choices' ? 'Options' : key;
    return `${label}: ${text}`;
  });
  return parts.length ? `${parts.join('.  ')}.` : null;
}

function isErrorBody(body: unknown): body is ApiErrorBody {
  if (!body || typeof body !== 'object' || !('error' in body)) return false;
  const error = (body as { error: unknown }).error;
  return !!error && typeof error === 'object' && 'messageKey' in error;
}

/**
 * The message and description of an error answer, with the field and value it names and a hint for
 * the common cases.  Riosoma's message key closes the description, so it can be searched for.
 */
export function describeError(
  status: number,
  body: unknown,
  method: string,
  path: string,
): { message: string; description: string } {
  if (!isErrorBody(body))
    return {
      message: `Riosoma answered with status ${status}`,
      description:
        status === 404
          ? 'Check the address in the Riosoma credential.  It should be the address you open Riosoma at.'
          : "The answer wasn't one of Riosoma's API errors.  Check the address in the Riosoma credential.",
    };
  const { code, messageKey, message, params } = body.error;
  const field = typeof params?.field === 'string' ? params.field : null;
  const lines = [
    describeParams(params),
    hintFor(messageKey, method, path),
    `Riosoma error: ${messageKey} (${code}, status ${status}).`,
  ].filter((line): line is string => !!line);
  return {
    message: field ? `${field}: ${message}` : message,
    description: lines.join('\n'),
  };
}

export function apiError(
  node: INode,
  status: number,
  body: unknown,
  method: string,
  path: string,
  itemIndex?: number,
): NodeApiError {
  const { message, description } = describeError(status, body, method, path);
  return new NodeApiError(node, (body && typeof body === 'object' ? body : {}) as JsonObject, {
    message,
    description,
    httpCode: String(status),
    ...(itemIndex === undefined ? {} : { itemIndex }),
  });
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  itemIndex?: number;
  /** Answer null instead of failing when Riosoma answers not found */
  missingOk?: boolean;
}

/**
 * Calls the REST API with the credential's token.  Error answers become n8n errors that carry
 * Riosoma's message, the field and value it names, and its message key.
 */
export async function riosomaRequest<T>(
  context: RiosomaContext,
  method: IHttpRequestMethods,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const credentials = await context.getCredentials<RiosomaCredentials>(CREDENTIALS);
  const base = serverAddress(credentials.url);
  const query = queryString(options.query);
  const request: IHttpRequestOptions = {
    method,
    url: `${base}/api/v1${path}${query ? `?${query}` : ''}`,
    json: true,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
    skipSslCertificateValidation: credentials.ignoreSslIssues === true,
    headers: { accept: 'application/json' },
    ...(options.body === undefined ? {} : { body: options.body as IHttpRequestOptions['body'] }),
  };
  let response: { statusCode: number; body: unknown };
  try {
    response = (await context.helpers.httpRequestWithAuthentication.call(context, CREDENTIALS, request)) as {
      statusCode: number;
      body: unknown;
    };
  } catch (error) {
    throw new NodeApiError(context.getNode(), error as JsonObject, {
      message: `Could not reach Riosoma at ${base}`,
      description: `${(error as Error).message}.  Check the address in the Riosoma credential and that n8n can reach it.`,
      ...(options.itemIndex === undefined ? {} : { itemIndex: options.itemIndex }),
    });
  }
  if (response.statusCode >= 200 && response.statusCode < 300) return response.body as T;
  if (response.statusCode === 404 && options.missingOk) return null as T;
  throw apiError(context.getNode(), response.statusCode, response.body, method, path, options.itemIndex);
}
