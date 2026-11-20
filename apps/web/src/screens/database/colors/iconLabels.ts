import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { IconSet } from '@riosoma/contracts';

export function iconBandLabel(set: IconSet, band: 0 | 1 | 2, i18n: I18n): string {
  if (set.labels[band].trim()) return set.labels[band].trim();
  const lower = i18n.number(set.thresholds[0], { maximumSignificantDigits: 21 });
  const upper = i18n.number(set.thresholds[1], { maximumSignificantDigits: 21 });
  return band === 0
    ? i18n._(msg({ id: 'views.color.icons.low', message: `Low (below ${lower})` }))
    : band === 1
      ? i18n._(msg({ id: 'views.color.icons.middle', message: `Middle (${lower} to below ${upper})` }))
      : i18n._(msg({ id: 'views.color.icons.high', message: `High (${upper} or more)` }));
}
