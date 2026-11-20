import { useRef, useState } from 'react';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { AiFootprintMine } from '@riosoma/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { faLeaf } from '@fortawesome/free-solid-svg-icons';
import { Icon } from '@riosoma/icons';
import { Button } from '@riosoma/ui';
import { useFootprintSummaryFormat } from './summary-format';
import { lazyFeature, LazyBoundary } from '../../shell/lazy';
import './footprint-pill.css';

const PopoverSurface = lazyFeature(() =>
  import('../../shell/PopoverSurface').then((module) => ({ default: module.PopoverSurface })),
);
const Breakdown = lazyFeature(() =>
  import('./FootprintBreakdown').then((module) => ({ default: module.FootprintBreakdown })),
);

/** The person's own AI use this month.  Rio asks again after each reply. */
export const footprintMineQuery = {
  queryKey: ['ai', 'footprint', 'mine'],
  queryFn: () => api<AiFootprintMine>('/api/ai/footprint/mine'),
  staleTime: 60_000,
};

/**
 * This month's AI cost and estimated carbon, in a small pill in Rio's panel for people who use AI.
 * It lives beside the assistant, so nobody reads it as a price for the app itself.
 * Pressing it opens where they come from.  It reports and compares with nothing, so it never
 * reads as a judgment.
 */
export function FootprintPill() {
  const query = useQuery(footprintMineQuery);
  const mine = query.data;
  if (!mine?.used) return null;
  return <Pill mine={mine} />;
}

function Pill({ mine }: { mine: AiFootprintMine }) {
  const { t } = useLingui();
  const format = useFootprintSummaryFormat();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const preload = () => {
    PopoverSurface.preload();
    Breakdown.preload();
  };
  const cost = mine.pricedCalls > 0 ? format.cost(mine.costUsd) : null;
  const carbon = mine.estimatedCalls > 0 ? format.carbon(mine.gwpG, true) : null;
  const calls = mine.calls;
  const shown =
    cost && carbon
      ? t({ id: 'ai.pill.both', message: `${cost} · ${carbon}` })
      : (cost ??
        carbon ??
        t({ id: 'ai.pill.uses', message: plural(calls, { one: '# AI use', other: '# AI uses' }) }));
  const title = t({ id: 'ai.pill.title', message: 'Your AI use this month' });
  return (
    <>
      <span
        ref={(element) => {
          trigger.current = element?.querySelector('button') ?? null;
        }}
        className="rio-deferred-menu-trigger"
      >
        <Button
          variant="quiet"
          size="sm"
          className="rio-footprint-pill"
          aria-haspopup="dialog"
          aria-expanded={open}
          onHoverStart={preload}
          onFocus={preload}
          onPress={() => setOpen(!open)}
          aria-label={t({ id: 'ai.pill.label', message: `${title}: ${shown}` })}
        >
          <span className="rio-footprint-pill__label">{shown}</span>
          <Icon icon={faLeaf} className="rio-footprint-pill__icon" />
        </Button>
      </span>
      {open && (
        <LazyBoundary size="popover" triggerRef={trigger}>
          <PopoverSurface
            triggerRef={trigger}
            onClose={() => setOpen(false)}
            title={title}
            className="rio-footprint-breakdown"
            dialogClassName="rio-footprint-breakdown__dialog"
          >
            <Breakdown mine={mine} title={title} onHelpOpen={() => setOpen(false)} />
          </PopoverSurface>
        </LazyBoundary>
      )}
    </>
  );
}
