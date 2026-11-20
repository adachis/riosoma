import { useLingui } from '@lingui/react/macro';
import type { AiRange } from '@riosoma/contracts';

type Units = ReadonlyArray<readonly [scale: number, unit: string]>;

/** Unit symbols, largest first.  A range uses the unit its high end needs, for both ends. */
const ENERGY: Units = [
  [1e6, 'MWh'],
  [1e3, 'kWh'],
  [1, 'Wh'],
];
const CARBON: Units = [
  [1e6, 't CO2e'],
  [1e3, 'kg CO2e'],
  [1, 'g CO2e'],
];

function unitFor(value: number, units: Units): readonly [number, string] {
  return units.find(([scale]) => value >= scale) ?? units[units.length - 1]!;
}

/**
 * Words for footprint estimates.  Every figure is a range, with two significant digits, since
 * more would claim a precision the method doesn't have.
 */
export function useFootprintSummaryFormat() {
  const { t, i18n } = useLingui();
  const number = (value: number) => i18n.number(value, { maximumSignificantDigits: 2 });
  const range = (value: AiRange, units: Units, compact: boolean) => {
    const [scale, unit] = unitFor(value.max, units);
    const low = number(value.min / scale);
    const high = number(value.max / scale);
    if (low === high) return t({ id: 'ai.footprint.value', message: `${low} ${unit}` });
    return compact
      ? t({ id: 'ai.footprint.rangeCompact', message: `${low}–${high} ${unit}` })
      : t({ id: 'ai.footprint.range', message: `${low} to ${high} ${unit}` });
  };
  const energy = (value: AiRange, compact = false) => range(value, ENERGY, compact);
  const carbon = (value: AiRange, compact = false) => range(value, CARBON, compact);
  return {
    energy,
    carbon,
    cost: (usd: number) =>
      i18n.number(usd, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: usd > 0 && usd < 1 ? 4 : 2,
      }),
  };
}
