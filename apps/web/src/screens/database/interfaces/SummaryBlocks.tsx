import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { faChartColumn, faTable } from '@fortawesome/free-solid-svg-icons';
import type { SummaryBlock } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { ChartBody, NumberBody } from '../dashboards/TileBodies';
import { BlockStatus, BlockUnavailable } from './BlockStatus';
import type { BlockContext } from './context';

/**
 * A number or chart block, drawn the way a dashboard tile is from the data the page's summary
 * request brought, with a chart's numbers a toggle away as a table.
 */
export function SummaryBody({
  block,
  name,
  context,
}: {
  block: SummaryBlock;
  name: string;
  context: BlockContext;
}) {
  const { t } = useLingui();
  const [asTable, setAsTable] = useState(false);
  const fields = context.schema.fields.get(block.source.tableId);
  if (!fields) return <BlockUnavailable />;
  const state = context.summaries.get(block.id);
  if (!state || state.status === 'loading') return <BlockStatus />;
  if (state.status === 'error')
    return <BlockStatus error={state} onRetry={() => context.onRetry(block.id)} />;
  const { data } = state;
  if (block.kind === 'number' && data.kind === 'number')
    return (
      <NumberBody
        tile={block}
        value={data.value}
        records={data.records}
        fields={fields}
        format={context.format}
      />
    );
  if (block.kind === 'chart' && data.kind === 'chart')
    return (
      <div className="rio-interface-chart">
        <Button
          className="rio-interface-chart__toggle"
          variant="quiet"
          size="sm"
          icon={asTable ? faChartColumn : faTable}
          aria-label={
            asTable
              ? t({ id: 'dashboards.tile.showChart', message: 'Show as chart' })
              : t({ id: 'dashboards.tile.showTable', message: 'Show as table' })
          }
          onPress={() => setAsTable(!asTable)}
        />
        <ChartBody
          tile={block}
          data={data}
          fields={fields}
          format={context.format}
          label={name}
          asTable={asTable}
        />
      </div>
    );
  // Data for an earlier version of the block: the fresh load is on its way.
  return <BlockStatus />;
}
