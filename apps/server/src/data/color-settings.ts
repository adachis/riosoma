import { isDeepStrictEqual } from 'node:util';
import {
  AppError,
  isBarField,
  isScaleField,
  isSparklineField,
  scaleValueFits,
  type GridConfig,
} from '@riosoma/contracts';
import type { StoredField } from './types.js';

function badViewSetting(
  setting: 'colorRules' | 'colorScales' | 'dataBars' | 'iconSets' | 'sparklines',
): never {
  throw new AppError('validation_failed', 'data.view.badSetting', { params: { setting } });
}

/**
 * Checks a view's conditional colors against its table.  Rules may name any field, as filters
 * may, and a condition that doesn't fit its field only colors nothing.  Scales and bars need a
 * field of a type they can measure, and fixed scale values of that field's kind.  Trashed fields
 * keep their settings, so restoring a field restores its colors.
 */
export function validateColorSettings(
  config: Pick<GridConfig, 'colorRules' | 'colorScales' | 'dataBars' | 'iconSets' | 'sparklines'>,
  active: ReadonlyMap<string, StoredField>,
  knownIds: ReadonlySet<string>,
  previous?: Pick<GridConfig, 'iconSets' | 'sparklines'>,
): void {
  for (const rule of config.colorRules)
    if (!knownIds.has(rule.condition.fieldId)) badViewSetting('colorRules');
  for (const scale of config.colorScales) {
    if (!knownIds.has(scale.fieldId)) badViewSetting('colorScales');
    const field = active.get(scale.fieldId);
    if (!field) continue;
    if (!isScaleField(field)) badViewSetting('colorScales');
    for (const stop of scale.stops)
      if (stop.value !== null && !scaleValueFits(field, stop.value)) badViewSetting('colorScales');
  }
  for (const bar of config.dataBars) {
    if (!knownIds.has(bar.fieldId)) badViewSetting('dataBars');
    const field = active.get(bar.fieldId);
    if (field && !isBarField(field)) badViewSetting('dataBars');
  }
  const previousSparklines = new Map(previous?.sparklines.map((setting) => [setting.fieldId, setting]));
  for (const setting of config.sparklines) {
    if (isDeepStrictEqual(setting, previousSparklines.get(setting.fieldId))) continue;
    if (!knownIds.has(setting.fieldId)) badViewSetting('sparklines');
    const field = active.get(setting.fieldId);
    if (field && !isSparklineField(field)) badViewSetting('sparklines');
    if (setting.order && field) {
      if ((field.type !== 'lookup' && field.type !== 'rollup') || !field.relation)
        badViewSetting('sparklines');
    }
  }
  const previousSets = new Map(previous?.iconSets.map((set) => [set.fieldId, set]));
  for (const set of config.iconSets) {
    // Field conversions leave saved sets dormant until the field can display them again.
    if (isDeepStrictEqual(set, previousSets.get(set.fieldId))) continue;
    if (!knownIds.has(set.fieldId)) badViewSetting('iconSets');
    const field = active.get(set.fieldId);
    if (field && !isBarField(field)) badViewSetting('iconSets');
  }
}
