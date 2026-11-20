import { Preferences } from '@riosoma/contracts';

/** Validation loads only for a visitor with stored choices, keeping ordinary startup small. */
export function parseDemoPreferences(value: unknown): Preferences {
  return Preferences.parse(value);
}
