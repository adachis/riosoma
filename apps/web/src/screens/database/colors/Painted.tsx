import { SparklineChart } from './SparklineChart';
import type { ReactNode } from 'react';
import { paintProps } from './dom';
import { lineColor, type Paint } from './paint';

/** A value on its color: a tint from the legibility tier, a data bar behind it, or both. */
export function Painted({ paint, children }: { paint?: Paint | null; children: ReactNode }) {
  if (!paint) return <>{children}</>;
  const { className, style } = paintProps(paint);
  return (
    <span className={`rio-color-value ${className}`} style={style}>
      {paint.icon ? (
        <span
          className="rio-color-icon"
          role="img"
          aria-label={paint.icon.label}
          style={{ color: lineColor(paint.icon.color) }}
        >
          {paint.icon.glyph}
        </span>
      ) : null}
      <span className="rio-color-value__content">
        {paint.sparkline ? <SparklineChart paint={paint.sparkline} /> : children}
      </span>
    </span>
  );
}
