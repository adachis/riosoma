import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { faLeaf } from '@fortawesome/free-solid-svg-icons';
import type { AiModelFootprint } from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import { useFootprintFormat } from './format';
import './footprint.css';

/**
 * One to three leaves for a model, by its estimated energy for a typical reply: three for the
 * least.  A model the method has no data for says "No estimate" instead.  Inside an option, where
 * the option's description reads the estimate out, `decorative` keeps them out of its name.
 */
export function Leaves({
  footprint,
  decorative = false,
}: {
  footprint: AiModelFootprint | null;
  decorative?: boolean;
}) {
  const { t } = useLingui();
  if (!footprint)
    return (
      <span className="rio-footprint-leaves rio-footprint-leaves--none" aria-hidden={decorative || undefined}>
        {t({ id: 'ai.leaves.none', message: 'No estimate' })}
      </span>
    );
  const leaves = footprint.leaves;
  const label = t({
    id: 'ai.leaves.label',
    message: plural(leaves, { one: '# of 3 leaves', other: '# of 3 leaves' }),
  });
  return (
    <span
      className="rio-footprint-leaves"
      data-leaves={leaves}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      {[1, 2, 3].map((position) => (
        <Icon
          key={position}
          icon={faLeaf}
          className={position <= leaves ? 'rio-footprint-leaves__on' : 'rio-footprint-leaves__off'}
        />
      ))}
    </span>
  );
}

/** The estimate behind a model's leaves, in words, for hover, focus, and screen readers. */
export function useLeafRange() {
  const { t } = useLingui();
  const format = useFootprintFormat();
  return (footprint: AiModelFootprint | null) => {
    if (!footprint)
      return t({ id: 'ai.leaves.noneDetail', message: 'No estimate: the method has no data for this model' });
    const energy = format.energy(footprint.energyWh);
    const tokens = footprint.outputTokens;
    const leaves = footprint.leaves;
    return t({
      id: 'ai.leaves.range',
      message: plural(leaves, {
        one: `# of 3 leaves.  Estimate: about ${energy} for a typical reply of ${tokens} tokens.  More leaves mean less energy.`,
        other: `# of 3 leaves.  Estimate: about ${energy} for a typical reply of ${tokens} tokens.  More leaves mean less energy.`,
      }),
    });
  };
}
