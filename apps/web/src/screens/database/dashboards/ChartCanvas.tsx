import { useEffect, useRef } from 'react';
import type { ChartOption } from './chart-option';
import { readChartTheme, watchTheme, type ChartTheme } from './chart-theme';
import { mountChart, type ChartHandle, type ChartPoint } from './echarts';
import './chart-canvas.css';

export interface ChartCanvasProps {
  /** Builds the chart in the colors of the theme where it sits */
  build(theme: ChartTheme): ChartOption;
  /** Names the chart for assistive technology.  The tile's data table describes it in full. */
  label: string;
  /** Called when someone clicks a bar, slice, or point.  The data table offers the same by keyboard. */
  onPick?(point: ChartPoint): void;
  /** Says how to reach what the pointer picks without one */
  describedBy?: string;
  className?: string;
}

/**
 * The drawn chart.  It loads with ECharts on demand, redraws when the theme, its color scheme, or
 * the tile's size changes, and describes itself as one image.
 */
export default function ChartCanvas({
  build,
  label,
  onPick,
  describedBy,
  className = 'rio-dashboard-chart__canvas',
}: ChartCanvasProps) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<ChartHandle | null>(null);
  const latest = useRef(build);
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);
  useEffect(() => {
    latest.current = build;
    if (chart.current && element.current) chart.current.update(build(readChartTheme(element.current)));
  }, [build]);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const handle = mountChart(target, (point) => pick.current?.(point));
    chart.current = handle;
    const draw = () => handle.update(latest.current(readChartTheme(target)));
    draw();
    const stopWatching = watchTheme(draw);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => handle.resize());
    observer?.observe(target);
    return () => {
      stopWatching();
      observer?.disconnect();
      handle.dispose();
      chart.current = null;
    };
  }, []);
  return (
    <div ref={element} className={className} role="img" aria-label={label} aria-describedby={describedBy} />
  );
}
