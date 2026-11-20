import { AppError, type NotificationConnection } from '@riosoma/contracts';
import type { PushPayload } from './push.js';

export type ChannelRequest = typeof fetch;

export class NotificationDeliveryError extends AppError {
  constructor(
    readonly serviceMethod: string,
    readonly serviceError?: string | number,
  ) {
    super('unavailable', 'notifications.delivery.failed');
  }
}

const failed = (method: string, code?: string | number) => new NotificationDeliveryError(method, code);

function serviceError(
  result: Record<string, unknown>,
  authorization?: string | null,
): string | number | undefined {
  const error = result.error;
  const code =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>).code
      : (error ?? result.error_code ?? result.code);
  // Log only service codes, excluding free-form text and credentials reflected by a service.
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (
    typeof code === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(code) &&
    !authorization?.includes(code)
  )
    return code;
  return undefined;
}

async function json(
  request: ChannelRequest,
  url: string,
  init: RequestInit,
  method: string,
): Promise<Record<string, unknown>> {
  try {
    const response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const result: unknown = await response.json();
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw failed(method);
    const body = result as Record<string, unknown>;
    if (!response.ok)
      throw failed(method, serviceError(body, new Headers(init.headers).get('authorization')));
    return body;
  } catch (error) {
    if (error instanceof NotificationDeliveryError) throw error;
    throw failed(method);
  }
}

export async function sendSlack(
  connection: Extract<NotificationConnection, { channel: 'slack' }>,
  email: string,
  payload: PushPayload,
  request: ChannelRequest = fetch,
): Promise<void> {
  const authorization = `Bearer ${connection.token}`;
  const call = async (method: string, body: Record<string, unknown> | URLSearchParams) => {
    const form = body instanceof URLSearchParams;
    const result = await json(
      request,
      `https://slack.com/api/${method}`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        },
        body: form ? body.toString() : JSON.stringify(body),
      },
      method,
    );
    if (result.ok !== true) throw failed(method, serviceError(result, authorization));
    return result;
  };
  const found = await call('users.lookupByEmail', new URLSearchParams({ email }));
  const user = found.user as { id?: string; deleted?: boolean } | undefined;
  if (!user?.id || user.deleted) throw failed('users.lookupByEmail');
  const opened = await call('conversations.open', { users: user.id });
  const channel = opened.channel as { id?: string } | undefined;
  if (!channel?.id) throw failed('conversations.open');
  await call('chat.postMessage', {
    channel: channel.id,
    text: `${payload.title}\n${payload.body}\n${payload.url}`,
    mrkdwn: false,
    unfurl_links: false,
    unfurl_media: false,
  });
}

/** A delegated Graph connection sends as its signed-in person and identifies recipients by email. */
export async function sendTeams(
  connection: Extract<NotificationConnection, { channel: 'teams' }>,
  email: string,
  payload: PushPayload,
  request: ChannelRequest = fetch,
  onRefresh?: (token: string) => Promise<void>,
): Promise<string | null> {
  const token = await json(
    request,
    `https://login.microsoftonline.com/${connection.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: connection.clientId,
        client_secret: connection.clientSecret,
        refresh_token: connection.refreshToken,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/.default offline_access',
      }).toString(),
    },
    'oauth2.token',
  );
  if (typeof token.access_token !== 'string') throw failed('oauth2.token', serviceError(token));
  if (typeof token.refresh_token === 'string') await onRefresh?.(token.refresh_token);
  const headers = { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' };
  const root = 'https://graph.microsoft.com/v1.0';
  const sender = await json(request, `${root}/me?$select=id`, { headers }, 'me');
  const escaped = email.replaceAll("'", "''");
  const search = new URLSearchParams({
    $filter: `mail eq '${escaped}' or userPrincipalName eq '${escaped}'`,
    $select: 'id',
    $top: '2',
  });
  const found = await json(request, `${root}/users?${search}`, { headers }, 'users');
  const people = found.value as Array<{ id?: string }> | undefined;
  const recipient = Array.isArray(people) && people.length === 1 ? people[0] : undefined;
  if (typeof sender.id !== 'string') throw failed('me');
  if (typeof recipient?.id !== 'string') throw failed('users');
  const chat = await json(
    request,
    `${root}/chats`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chatType: 'oneOnOne',
        members: [...new Set([sender.id, recipient.id])].map((id) => ({
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          roles: ['owner'],
          'user@odata.bind': `${root}/users('${encodeURIComponent(id)}')`,
        })),
      }),
    },
    'chats',
  );
  if (typeof chat.id !== 'string') throw failed('chats');
  await json(
    request,
    `${root}/chats/${encodeURIComponent(chat.id)}/messages`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        body: { contentType: 'text', content: `${payload.title}\n${payload.body}\n${payload.url}` },
      }),
    },
    'chats.messages',
  );
  return typeof token.refresh_token === 'string' ? token.refresh_token : null;
}

export async function sendSms(
  connection: Extract<NotificationConnection, { channel: 'sms' }>,
  number: string,
  text: string,
  request: ChannelRequest = fetch,
): Promise<void> {
  const result = await json(
    request,
    `https://api.twilio.com/2010-04-01/Accounts/${connection.accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${connection.accountSid}:${connection.authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: connection.from, To: number, Body: text }).toString(),
    },
    'Messages.create',
  );
  if (result.error_code || result.status === 'failed' || result.status === 'undelivered')
    throw failed('Messages.create', serviceError(result));
}
