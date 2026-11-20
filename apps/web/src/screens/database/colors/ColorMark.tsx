import type { CSSProperties } from 'react';
import { useLingui } from '@lingui/react/macro';
import { colorDescription } from './dom';
import { lineColor, softColor, type Paint, type RecordPaint } from './paint';
import './colors.css';

/**
 * A small dot showing the color a view gives a record or one of its fields.  A rule's dot is named
 * by the rule, so screen readers hear what the color means.  A scale's dot only echoes the value
 * beside it, so it stays out of the way.
 */
export function ColorMark({ paint, record }: { paint?: Paint | null; record?: RecordPaint | null }) {
  const { i18n } = useLingui();
  const icon = paint?.icon ? (
    <span
      className="rio-color-icon"
      role="img"
      aria-label={paint.icon.label}
      style={{ color: lineColor(paint.icon.color) }}
    >
      {paint.icon.glyph}
    </span>
  ) : null;
  const color = record?.color ?? paint?.color ?? null;
  const bar = paint?.bar ?? null;
  const fill = color ? lineColor(color) : (paint?.fill ?? (bar ? softColor(bar.color) : null));
  if (!fill) return icon;
  const edge = color ? lineColor(color) : !paint?.fill && bar ? lineColor(bar.color) : null;
  const style = {
    '--rio-color-mark': fill,
    ...(edge ? { '--rio-color-mark-line': edge } : {}),
  } as CSSProperties;
  const label = colorDescription(record ? [record.label] : (paint?.labels ?? []), i18n.locale || 'en-US');
  return (
    <>
      {icon}
      {label ? (
        <span className="rio-color-mark" style={style} role="img" aria-label={label} />
      ) : (
        <span className="rio-color-mark" style={style} aria-hidden="true" />
      )}
    </>
  );
}
