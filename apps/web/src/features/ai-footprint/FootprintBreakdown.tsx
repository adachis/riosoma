import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { AiFootprintMine, AiUsageTotals } from '@riosoma/contracts';
import { Heading } from '@riosoma/ui';
import { FootprintHelp } from './FootprintHelp';
import { useFootprintFormat } from './format';
import './footprint-breakdown.css';

export function FootprintBreakdown({
  mine,
  title,
  onHelpOpen,
}: {
  mine: AiFootprintMine;
  title: string;
  onHelpOpen(): void;
}) {
  const { t } = useLingui();
  const format = useFootprintFormat();
  const unestimated = mine.calls - mine.estimatedCalls;
  const parts = (row: AiUsageTotals) => {
    const calls = row.calls;
    const words = [t({ id: 'ai.pill.calls', message: plural(calls, { one: '# use', other: '# uses' }) })];
    if (row.pricedCalls > 0) words.push(format.cost(row.costUsd));
    if (row.estimatedCalls > 0) words.push(format.energy(row.energyWh), format.carbon(row.gwpG));
    return words.join(' · ');
  };
  return (
    <>
      <Heading level={2}>{title}</Heading>
      <ul className="rio-footprint-breakdown__list">
        {mine.byFeature.map((row) => (
          <li key={row.feature}>
            <span className="rio-footprint-breakdown__feature">{format.feature(row.feature)}</span>
            <span>{parts(row)}</span>
          </li>
        ))}
      </ul>
      <p className="rio-footprint-breakdown__note">
        {t({
          id: 'ai.pill.note',
          message: 'Costs follow each model’s list price.  Energy and carbon are estimates, shown as ranges.',
        })}
        {unestimated > 0
          ? ` ${t({
              id: 'ai.pill.unestimated',
              message: plural(unestimated, {
                one: '# use has no estimate, because the method has no data for its model or it generated nothing.',
                other:
                  '# uses have no estimate, because the method has no data for their models or they generated nothing.',
              }),
            })}`
          : null}
      </p>
      <FootprintHelp onOpen={onHelpOpen} />
    </>
  );
}
