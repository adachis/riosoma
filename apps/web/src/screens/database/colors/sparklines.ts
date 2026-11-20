import { trustedHTML } from '../../../security/trusted-types';
import { msg } from '@lingui/core/macro';
import type { I18n } from '@lingui/core';
import { sparklineSummary, type Sparkline, type SparklineShape } from '@riosoma/contracts';

export interface SparklinePaint {
  shape: SparklineShape;
  setting: Sparkline;
  label: string;
}

export function sparklineLabel(values: readonly number[], i18n: I18n): string {
  const summary = sparklineSummary(values);
  if (!summary) return '';
  const precise = { maximumSignificantDigits: 21 };
  const min = i18n.number(summary.min, precise),
    max = i18n.number(summary.max, precise),
    last = i18n.number(summary.last, precise);
  const trend = i18n._(
    summary.trend === 'up'
      ? msg({ id: 'views.sparkline.up', message: 'rising' })
      : summary.trend === 'down'
        ? msg({ id: 'views.sparkline.down', message: 'falling' })
        : msg({ id: 'views.sparkline.flat', message: 'unchanged' }),
  );
  return i18n._(
    msg({
      id: 'views.sparkline.description',
      message: `Minimum ${min}, maximum ${max}, last ${last}; trend ${trend}`,
    }),
  );
}

export function sparklineColor(color: Sparkline['color']): string {
  return color === 'accent' ? 'var(--rio-aa-accent-text)' : `var(--rio-aa-choice-${color})`;
}

const markup = new WeakMap<SparklineShape, Map<string, string>>();

/** Only generated numeric geometry and enumerated token colors enter this markup. */
export function sparklineSvg(
  paint: SparklinePaint,
  colors = {
    series: sparklineColor(paint.setting.color),
    highlight: paint.setting.color === 'gray' ? 'var(--rio-aa-accent-text)' : 'var(--rio-aa-choice-gray)',
    negative: 'var(--rio-aa-choice-red)',
  },
): string {
  const { path, marks, bars } = paint.shape;
  let cached = markup.get(paint.shape);
  if (!cached) {
    cached = new Map();
    markup.set(paint.shape, cached);
  }
  const key = `${colors.series}|${colors.highlight}|${colors.negative}`;
  const known = cached.get(key);
  if (known !== undefined) return known;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="24" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
    (path
      ? `<path d="${path}" fill="none" stroke="${colors.series}" stroke-width="1.5" stroke-linejoin="round"/>`
      : '') +
    marks.map((mark) => `<circle cx="${mark.x}" cy="${mark.y}" r="2" fill="${colors.highlight}"/>`).join('') +
    bars
      .map(
        (bar) =>
          `<rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" fill="${bar.highlighted ? colors.highlight : bar.negative ? colors.negative : colors.series}"/>`,
      )
      .join('') +
    '</svg>';
  cached.set(key, svg);
  if (cached.size > 8) cached.delete(cached.keys().next().value!);
  return svg;
}

const pending = new Map<HTMLElement, SparklinePaint>();
const drawn = new WeakMap<HTMLElement, string>();
const painted = new WeakMap<HTMLElement, SparklinePaint>();
let scheduled = false;

function draw(node: HTMLElement, paint: SparklinePaint): void {
  const svg = sparklineSvg(paint);
  if (drawn.get(node) !== svg || !node.firstChild) node.innerHTML = trustedHTML(svg);
  drawn.set(node, svg);
  painted.set(node, paint);
}

function schedule(): void {
  if (scheduled || !pending.size) return;
  scheduled = true;
  const flush = (deadline: Pick<IdleDeadline, 'timeRemaining'>) => {
    scheduled = false;
    for (const [node, paint] of pending) {
      if (deadline.timeRemaining() < 1) break;
      pending.delete(node);
      if (node.isConnected) draw(node, paint);
    }
    schedule();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(flush);
  else
    setTimeout(() => {
      const end = performance.now() + 2;
      flush({ timeRemaining: () => Math.max(0, end - performance.now()) });
    }, 16);
}

/** Prepare overscan charts between frames; a cell entering the viewport always draws immediately. */
export function drawSparkline(node: HTMLElement, paint: SparklinePaint, visible = true): void {
  node.title = paint.label;
  if (visible) {
    pending.delete(node);
    draw(node, paint);
  } else {
    // A pooled node must not flash a previous row while its replacement waits for idle time.
    if (drawn.has(node) && painted.get(node) !== paint) {
      node.replaceChildren();
      drawn.delete(node);
      painted.delete(node);
    }
    pending.set(node, paint);
    schedule();
  }
}
