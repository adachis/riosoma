import { feedbackPath, type FeedbackContext, type OrgSettings, type Preferences } from '@riosoma/contracts';
import { themeFor } from '../../preferences';
import { recentClientErrors } from './errors';

/**
 * What goes with a piece of feedback.  The dialog shows this very object to the sender and sends
 * it unchanged, so what they read is what the admins get.
 */

interface Browser {
  userAgent?: string;
  platform?: string;
}

const BROWSERS: Array<[name: string, pattern: RegExp]> = [
  ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
  ['Opera', /OPR\/(\d+)/],
  ['Samsung Internet', /SamsungBrowser\/(\d+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /Version\/(\d+)[.\d]* (?:Mobile\/\S+ )?Safari\//],
];

/** The browser's name and major version, such as `Firefox 140`, or nothing when it can't tell. */
export function browserName(userAgent = ''): string {
  for (const [name, pattern] of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) return `${name} ${match[1]}`;
  }
  return '';
}

/** The operating system, such as `macOS` or `Android`, or nothing when it can't tell. */
export function platformName({ userAgent = '', platform = '' }: Browser = {}): string {
  if (/iPhone|iPod/.test(userAgent)) return 'iOS';
  if (/iPad/.test(userAgent)) return 'iPadOS';
  if (/Android/.test(userAgent)) return 'Android';
  if (/CrOS/.test(userAgent)) return 'ChromeOS';
  if (/Windows/.test(userAgent) || /^Win/.test(platform)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(userAgent) || /^Mac/.test(platform)) return 'macOS';
  if (/Linux/.test(userAgent) || /Linux/.test(platform)) return 'Linux';
  return '';
}

/** The theme as the person sees it: its name, then its color scheme and mode where chosen. */
export function themeName(preferences: Preferences | undefined, org: OrgSettings | undefined): string {
  const choice = themeFor(preferences, org);
  return [choice.theme, choice.scheme, choice.mode].filter(Boolean).join(' / ');
}

export interface ContextSources {
  pathname: string;
  version: string | undefined;
  browser?: Browser;
  preferences: Preferences | undefined;
  org: OrgSettings | undefined;
  language: string;
}

/** The context for feedback sent from here, now. */
export function feedbackContext(sources: ContextSources): FeedbackContext {
  const browser = sources.browser ?? globalThis.navigator ?? {};
  return {
    path: feedbackPath(sources.pathname),
    appVersion: (sources.version ?? '').slice(0, 60),
    browser: browserName(browser.userAgent),
    platform: platformName(browser),
    theme: themeName(sources.preferences, sources.org).slice(0, 120),
    language: sources.language.slice(0, 35),
    errors: recentClientErrors(),
  };
}
