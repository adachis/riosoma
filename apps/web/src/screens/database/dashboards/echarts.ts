// ECharts names its registration `use`, which reads as a React hook, so it goes by another name here.
import { init, use as register } from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ChartOption } from './chart-option';

// Only what dashboards draw, so the bundle carries nothing else.
register([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export interface ChartHandle {
  update(option: ChartOption): void;
  resize(): void;
  dispose(): void;
}

/** What someone clicked: a category's bar or point, or a pie's slice, and its series. */
export interface ChartPoint {
  dataIndex: number;
  /** Zero for a pie, which draws one series */
  seriesIndex: number;
}

/** Draws charts into an element.  Tests replace this module, since they have no canvas. */
export function mountChart(element: HTMLElement, onPick?: (point: ChartPoint) => void): ChartHandle {
  const chart = init(element, null, { renderer: 'canvas' });
  if (onPick)
    chart.on('click', (params) => {
      if (typeof params.dataIndex === 'number')
        onPick({ dataIndex: params.dataIndex, seriesIndex: params.seriesIndex ?? 0 });
    });
  return {
    update: (option) => chart.setOption(option, { notMerge: true }),
    resize: () => chart.resize(),
    dispose: () => chart.dispose(),
  };
}
