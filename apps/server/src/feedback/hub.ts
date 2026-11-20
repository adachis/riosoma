import { createHash } from 'node:crypto';
import {
  AppError,
  HubBugReport,
  REPORTED_VERSION_PATTERN,
  redactHubText,
  type FeedbackContext,
} from '@riosoma/contracts';
import { callOut, systemResolve } from '../automations/outbound.js';
import { DEFAULT_HUB_URL, type RuntimeConfig } from '../config.js';
import { allowsPrivate } from '../webhooks/url.js';

export function hubUrl(config: RuntimeConfig): string | null {
  return config.hubUrl === null ? null : `${(config.hubUrl ?? DEFAULT_HUB_URL).replace(/\/+$/, '')}/bugs`;
}

/**
 * The preview and the send use the same redacted, bounded fields, with no screenshot or sender.
 * The version comes from the sender's browser, so anything but a release version goes as `custom`.
 */
export function hubPayload(installId: string, message: string, context: FeedbackContext): HubBugReport {
  const description = redactHubText(Array.from(redactHubText(message)).slice(0, 2_000).join('')) || '[…]';
  const title = redactHubText((description.split('\n')[0] ?? '').slice(0, 80)) || '[…]';
  return HubBugReport.parse({
    installId,
    fingerprint: createHash('sha256').update(description).digest('hex'),
    version: REPORTED_VERSION_PATTERN.test(context.appVersion) ? context.appVersion : 'custom',
    platform: redactHubText(context.platform) || 'unknown',
    title,
    description,
  });
}

export async function sendHubReport(config: RuntimeConfig, payload: HubBugReport): Promise<string | null> {
  return hubRequest(config, payload);
}

/** A status lookup only reads an accepted report, even while issue creation is still in flight. */
export async function refreshHubReport(config: RuntimeConfig, fingerprint: string): Promise<string | null> {
  return hubRequest(config, fingerprint);
}

async function hubRequest(config: RuntimeConfig, report: HubBugReport | string): Promise<string | null> {
  const url = hubUrl(config);
  if (!url) throw new AppError('conflict', 'feedback.hub.off');
  try {
    const response = await callOut(
      typeof report === 'string'
        ? { url: `${url}/${encodeURIComponent(report)}`, method: 'GET', headers: {}, body: null }
        : {
            url,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(report),
          },
      {
        resolve: systemResolve,
        allowPrivate: allowsPrivate(url, config),
        requestLimit: 16 * 1024,
        responseLimit: 4 * 1024,
      },
    );
    if ((response.status !== 200 && response.status !== 202) || response.truncated) throw new Error();
    const result = JSON.parse(response.body) as { issueUrl?: unknown };
    if (response.status === 202 && result.issueUrl === null) return null;
    if (
      typeof result.issueUrl !== 'string' ||
      result.issueUrl.length > 2_000 ||
      !URL.canParse(result.issueUrl)
    )
      throw new Error();
    const issue = new URL(result.issueUrl);
    if (issue.protocol !== 'https:' || issue.username || issue.password) throw new Error();
    return result.issueUrl;
  } catch {
    throw new AppError('unavailable', 'feedback.hub.failed');
  }
}
