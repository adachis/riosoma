import type { Queryable } from '@riosoma/db';
import {
  mapAutomationSteps,
  flattenAutomationSteps,
  AppError,
  type AutomationConfig,
  type AutomationStep,
} from '@riosoma/contracts';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { credentialBinding, sealCredential, unsealCredential } from '../credentials/service.js';
import { localKey, sealEnvelope } from '../credentials/envelope.js';
import { callOut, type OutboundRequest, type OutboundResponse, type Resolve } from './outbound.js';
import { fillText, pieces, soleToken, type Resolver } from './tokens.js';

export type MessageStep = Extract<
  AutomationStep,
  { kind: 'slack' | 'teams' | 'studioFlow' | 'discord' | 'sms' }
>;
export const E164 = /^\+[1-9][0-9]{1,14}$/;

export function isMessageStep(step: AutomationStep): step is MessageStep {
  return (
    step.kind === 'slack' ||
    step.kind === 'teams' ||
    step.kind === 'studioFlow' ||
    step.kind === 'discord' ||
    step.kind === 'sms'
  );
}

export function webhookAllowed(kind: Exclude<MessageStep['kind'], 'sms'>, address: string): boolean {
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    const host = url.hostname;
    switch (kind) {
      case 'slack':
        return host === 'hooks.slack.com';
      case 'studioFlow':
      case 'teams':
        // Workflows made since late 2025 answer on their environment's own Power Platform host, and
        // older ones on Logic Apps' hosts.  Incoming webhooks from the retired Office 365
        // connectors answer on webhook.office.com.
        return (
          host.endsWith('.environment.api.powerplatform.com') ||
          host.endsWith('.logic.azure.com') ||
          host.endsWith('.webhook.office.com')
        );
      case 'discord':
        return (
          (host === 'discord.com' || host === 'discordapp.com') &&
          /^\/api\/webhooks\/[^/]+\/[^/]+\/?$/.test(url.pathname)
        );
    }
  } catch {
    return false;
  }
}

/** The name a step's credential is sealed under.  Steps saved before names were kept use the first form. */
export function secretName(step: MessageStep): string {
  const own = `${step.id}:${step.kind}`;
  return step.secretRef?.startsWith(`${own}:`) ? step.secretRef : own;
}

const context = (automationId: string, name: string) => `riosoma.automations.message:${automationId}:${name}`;

/**
 * Credentials stay outside the configuration that changes, undo, and schema responses carry.
 * Every new credential is sealed under a name of its own, which the step keeps in `secretRef`,
 * and nothing sealed is ever replaced, so the published version, the draft, kept versions, and
 * undo each find the credential they were saved with.  A step that comes without its name keeps
 * the one it had in `previous`, the configuration it replaces.
 */
export async function sealMessages(
  key: Buffer,
  automationId: string,
  orgId: string,
  config: AutomationConfig,
  secrets: Record<string, string> = {},
  previous?: AutomationConfig,
  db?: Queryable,
  preview = false,
): Promise<{ config: AutomationConfig; secrets: Record<string, string> }> {
  const next = { ...secrets };
  const before = new Map(
    flattenAutomationSteps(previous?.steps ?? [])
      .filter(isMessageStep)
      .map((step) => [`${step.id}:${step.kind}`, step]),
  );
  // Credentials are sealed one by one (a vault may be remote), then put back in place, nested
  // steps included.
  const sealedById = new Map<string, MessageStep>();
  for (const step of flattenAutomationSteps(config.steps)) {
    if (!isMessageStep(step)) continue;
    const value = step.kind === 'sms' ? step.authToken : step.webhookUrl;
    const own = `${step.id}:${step.kind}`;
    let name = secretName(step);
    if (!next[name] || name !== step.secretRef) {
      // Only a name this step was given counts, so no step borrows another's credential.
      const kept = before.get(own);
      name = kept ? secretName(kept) : own;
    }
    if (value) {
      name = `${own}:${randomBytes(9).toString('base64url')}`;
      // Validation rolls back database writes, so its credentials must stay local as well.
      next[name] = preview
        ? await sealEnvelope(localKey(key), value, credentialBinding(orgId, context(automationId, name)))
        : await sealCredential(key, value, context(automationId, name), orgId, db);
    }
    const secretSaved = Boolean(next[name]);
    const sealed: MessageStep =
      step.kind === 'sms'
        ? { ...step, authToken: '', secretSaved }
        : { ...step, webhookUrl: '', secretSaved };
    if (name === own) delete sealed.secretRef;
    else sealed.secretRef = name;
    sealedById.set(step.id, sealed);
  }
  const steps = mapAutomationSteps(config.steps, (step) =>
    isMessageStep(step) ? (sealedById.get(step.id) ?? step) : step,
  );
  return { config: { ...config, steps }, secrets: next };
}

export async function messageSecret(
  key: Buffer,
  automationId: string,
  orgId: string,
  step: MessageStep,
  secrets: Record<string, string>,
  db?: Queryable,
): Promise<string> {
  const name = secretName(step);
  const stored = secrets[name];
  if (!stored) throw new AppError('validation_failed', 'automations.messaging.secretRequired');
  return unsealCredential(key, stored, context(automationId, name), orgId, db);
}

/**
 * A record's value as the service shows it, never as markup.  Each service needs only its own
 * escaping, so values keep every character people typed, email addresses included.
 */
function escapeValue(kind: MessageStep['kind'], value: string): string {
  switch (kind) {
    case 'sms':
    case 'studioFlow':
      return value;
    // Slack's mentions, channel pings, and links all live inside angle brackets, and its own escapes
    // for them are these three entities.
    case 'slack':
      return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Discord and Teams read Markdown, which a backslash escapes.  Discord's mentions never ping,
    // since the message turns them all off.
    default:
      return value.replace(/[\\`*_{}[\]()<>#+.!|~-]/g, '\\$&');
  }
}

export function messageText(step: MessageStep, resolve: Resolver): string {
  return pieces(step.body)
    .map((piece) =>
      'text' in piece ? piece.text : escapeValue(step.kind, resolve(piece.ref, piece.raw).text),
    )
    .join('');
}

export function messageRequest(step: MessageStep, secret: string, resolve: Resolver): OutboundRequest {
  const text = messageText(step, resolve);
  const invalid = (key: string): never => {
    throw new AppError('validation_failed', key);
  };
  if (!text.trim()) invalid('errors.validationFailed');
  if (step.kind === 'sms') {
    const token = soleToken(step.to);
    const value = token ? resolve(token.ref, token.raw) : null;
    if (token && value?.cell?.field.type !== 'phone') invalid('automations.messaging.phone');
    const to = value?.cell ? String(value.cell.value ?? '') : fillText(step.to, resolve);
    if (!E164.test(to) || !E164.test(step.from)) invalid('automations.messaging.phone');
    if (text.length > 1600) invalid('automations.messaging.length');
    if (!/^AC[0-9a-fA-F]{32}$/.test(step.accountSid)) invalid('errors.validationFailed');
    return {
      url: `https://api.twilio.com/2010-04-01/Accounts/${step.accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${step.accountSid}:${secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: step.from, To: to, Body: text }).toString(),
    };
  }
  if (!webhookAllowed(step.kind, secret)) invalid('automations.messaging.webhook');
  const recipient = step.kind === 'studioFlow' ? fillText(step.recipient, resolve).trim() : '';
  if (step.kind === 'studioFlow' && !recipient) invalid('errors.validationFailed');
  const title = step.kind === 'studioFlow' ? fillText(step.title, resolve).trim() : '';
  const payload =
    step.kind === 'studioFlow'
      ? {
          message: text,
          ...(title ? { title } : {}),
          recipient,
          recordUrl: fillText(step.recordUrl, resolve),
        }
      : step.kind === 'slack'
        ? { text }
        : step.kind === 'discord'
          ? { content: text, allowed_mentions: { parse: [], users: [], roles: [], replied_user: false } }
          : {
              type: 'message',
              attachments: [
                {
                  contentType: 'application/vnd.microsoft.card.adaptive',
                  contentUrl: null,
                  content: {
                    type: 'AdaptiveCard',
                    version: '1.2',
                    body: [{ type: 'TextBlock', text, wrap: true }],
                  },
                },
              ],
            };
  return {
    url: secret,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

/** Only provider codes leave this boundary, never response text or a request credential. */
export function providerCode(kind: MessageStep['kind'], response: OutboundResponse): string | number | null {
  if (kind === 'slack') {
    const known = new Set([
      'invalid_payload',
      'user_not_found',
      'action_prohibited',
      'channel_not_found',
      'channel_is_archived',
      'rollup_error',
      'no_text',
      'no_service',
      'no_service_id',
      'no_team',
      'team_disabled',
      'invalid_token',
      'posting_to_general_channel_denied',
      'too_many_attachments',
    ]);
    return known.has(response.body.trim()) ? response.body.trim() : null;
  }
  try {
    const body = JSON.parse(response.body) as {
      code?: unknown;
      error_code?: unknown;
      error?: { code?: unknown };
    };
    const code =
      kind === 'sms'
        ? (body.error_code ?? body.code)
        : kind === 'teams' || kind === 'studioFlow'
          ? body.error?.code
          : body.code;
    if (typeof code === 'number' && Number.isSafeInteger(code)) return code;
    if (typeof code === 'string' && /^\d{1,10}$/.test(code)) return code;
    if (
      (kind === 'teams' || kind === 'studioFlow') &&
      typeof code === 'string' &&
      [
        'InvalidRequestContent',
        'InvalidTemplate',
        'WorkflowTriggerIsNotEnabled',
        'AuthorizationFailed',
        'TriggerRequestNotValid',
        'TooManyRequests',
      ].includes(code)
    )
      return code;
  } catch {
    /* Some successful webhooks return no JSON. */
  }
  return null;
}

export interface MessageDeliveryOptions {
  resolve: Resolve;
  allowPrivate: boolean;
  timeoutMs: number;
  renew(): Promise<void>;
  /** Injected only by tests, never read from instance or organization settings. */
  testBaseUrls?: Partial<Record<MessageStep['kind'], string>>;
}

export async function deliverMessage(
  step: MessageStep,
  request: OutboundRequest,
  options: MessageDeliveryOptions,
): Promise<{ status: number; errorCode: string | number | null }> {
  const override = process.env.NODE_ENV === 'test' ? options.testBaseUrls?.[step.kind] : undefined;
  if (override) {
    const original = new URL(request.url);
    request = { ...request, url: `${override}${original.pathname}${original.search}` };
  }
  for (let attempt = 0; ; attempt += 1) {
    await options.renew();
    const response = await callOut(request, options);
    if (attempt < 2 && (response.status === 429 || (response.status >= 500 && response.status <= 599))) {
      await delay(250 * 2 ** attempt);
      continue;
    }
    return { status: response.status, errorCode: providerCode(step.kind, response) };
  }
}
