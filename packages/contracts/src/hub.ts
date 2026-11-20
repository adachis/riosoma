import { z } from 'zod';
import { REPORTED_VERSION_PATTERN } from './updates.js';

/** Redact again at both boundaries, including free text an admin chose to publish. */
export function redactHubText(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    })
    .join('')
    .replace(/https?:\/\/[^\s<>]+/gi, '[url]')
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-f\d]{0,4}:){2,}[a-f\d:]*\b/gi, '[address]')
    .replace(
      /\b(?:Bearer\s+\S+|(?:(?:[a-z][a-z0-9]*[_-])*(?:token|password|secret|api[_-]?key)|accessToken|refreshToken|clientSecret)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+))/gi,
      '[secret]',
    )
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`/g, '[…]')
    .replace(/\b\d{5,}\b/g, '[number]')
    .trim();
}

const redacted = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => redactHubText(value) === value);

/**
 * Screenshots, identities, paths, headers, and arbitrary context have no place in this contract.
 * The version is published on every report of the same bug, so it is a release version or `custom`
 * and never free text.
 */
export const HubBugReport = z.strictObject({
  installId: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().regex(REPORTED_VERSION_PATTERN),
  platform: redacted(80),
  title: redacted(80),
  description: redacted(10_000),
});
export type HubBugReport = z.infer<typeof HubBugReport>;

export interface FeedbackHubSettings {
  enabled: boolean;
  canChange: boolean;
  url: string | null;
  /** An example with the same fields and redaction as an actual report. */
  preview: HubBugReport;
}

export interface FeedbackHubPreview {
  url: string;
  payload: HubBugReport;
}
