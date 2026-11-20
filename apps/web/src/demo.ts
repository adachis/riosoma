import { recoverImport } from './asset-recovery';
import type { Preferences, SessionInfo } from '@riosoma/contracts';
import { msg } from '@lingui/core/macro';
import { toast } from '@riosoma/ui';
import { i18n } from './i18n';

let demo = false;
let lastNotice = -Infinity;
const PREFERENCES_KEY = 'rio.demo.preferences';
let preferencesInMemory: Preferences | undefined;

/** Set only from the session response, which is the sole source of demo state. */
export function setDemoSession(session: SessionInfo | null): void {
  demo = session?.demo === true;
}

export function isDemoSession(): boolean {
  return demo;
}

export function demoNotice(): void {
  const now = Date.now();
  if (now - lastNotice < 4000) return;
  lastNotice = now;
  toast.show({
    tone: 'info',
    title: i18n._(msg({ id: 'demo.readOnly', message: "This is a read-only demo.  Changes aren't saved." })),
  });
}

export function demoRefusal(error: unknown): boolean {
  if ((error as { info?: { messageKey?: string } })?.info?.messageKey !== 'demo.readOnly') return false;
  demoNotice();
  return true;
}

export async function demoPreferences(fallback: Preferences = {}): Promise<Preferences> {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    if (stored === null) return preferencesInMemory ?? fallback;
    const { parseDemoPreferences } = await recoverImport(() => import('./demo-preferences'));
    return parseDemoPreferences(JSON.parse(stored));
  } catch {
    return preferencesInMemory ?? fallback;
  }
}

export function saveDemoPreferences(preferences: Preferences): void {
  preferencesInMemory = preferences;
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    /* Choices still apply for this visit when storage is unavailable. */
  }
}
