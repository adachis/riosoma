import { useLingui } from '@lingui/react/macro';
import type { AiFootprint } from '@riosoma/contracts';
import { FootprintHelp } from './FootprintHelp';
import { useFootprintFormat } from './format';
import './footprint.css';

/**
 * A reply's estimated energy and carbon, in one quiet line beside its cost, with a way to read how
 * it's estimated.  A model the method has no data for says so instead of guessing.
 */
export function FootprintLine({ footprint }: { footprint: AiFootprint | null }) {
  const { t } = useLingui();
  const format = useFootprintFormat();
  const both = footprint ? format.both(footprint) : null;
  return (
    <p className="rio-footprint__line">
      <span>
        {both === null
          ? t({ id: 'ai.footprint.none', message: 'No energy or carbon estimate for this model' })
          : t({ id: 'ai.footprint.estimate', message: `Estimate: ${both}` })}
      </span>
      <FootprintHelp />
    </p>
  );
}
