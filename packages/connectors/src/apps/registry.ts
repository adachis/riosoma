import { registerAppCatalog } from '@riosoma/contracts';
import type { AppPreset } from './types.js';

/** One index supplies the connector, source validation, and required secrets. */
export function registerAppPresets(presets: readonly AppPreset[]): readonly AppPreset[] {
  registerAppCatalog(presets.map((preset) => preset.catalog));
  return presets;
}
