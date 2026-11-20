import type { CSSProperties } from 'react';
import { lineColor, softColor, type Paint, type RecordPaint } from './paint';
import './colors.css';

/**
 * Colors drawn on elements: classes for what's drawn and `--rio-color-*` variables for the colors.
 * The grid sets them on its recycled cells directly, and React views pass the same through `style`.
 */

function setVariable(node: HTMLElement, name: string, value: string | null): void {
  if (value === null) {
    if (node.style.getPropertyValue(name)) node.style.removeProperty(name);
  } else if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

function variables(paint: Paint | null): Record<string, string | null> {
  const bar = paint?.bar ?? null;
  return {
    '--rio-color-fill': paint?.fill ?? null,
    '--rio-color-bar-size': bar ? `${bar.size}%` : null,
    '--rio-color-bar-fill': bar ? softColor(bar.color) : null,
    '--rio-color-bar-line': bar ? lineColor(bar.color) : null,
  };
}

function classes(paint: Paint | null): Record<string, boolean> {
  return {
    'rio-color-fill': paint?.fill != null,
    'rio-color-bar': paint?.bar != null,
    'rio-color-bar--bare': paint?.bar != null && !paint.bar.showValue,
  };
}

/** Draws a cell's color on an element, clearing whatever an earlier value drew there. */
export function paintElement(node: HTMLElement, paint: Paint | null): void {
  for (const [name, on] of Object.entries(classes(paint))) node.classList.toggle(name, on);
  for (const [name, value] of Object.entries(variables(paint))) setVariable(node, name, value);
  const previous = node.querySelector(':scope > .rio-color-icon');
  node.classList.toggle('rio-color-icon-cell', !!paint?.icon);
  if (!paint?.icon) previous?.remove();
  else {
    const mark = previous ?? document.createElement('span');
    mark.className = 'rio-color-icon';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = paint.icon.glyph;
    mark.setAttribute('title', paint.icon.label);
    (mark as HTMLElement).style.color = lineColor(paint.icon.color);
    if (!previous) node.append(mark);
  }
}

/** The classes that tint a grid row with its record's color. */
export function rowColorClass(record: RecordPaint | null): string | null {
  return record ? `rio-color-row rio-color-row--${record.color}` : null;
}

/** A cell's color as a class name and style, for React elements. */
export function paintProps(paint: Paint | null): { className: string; style: CSSProperties } {
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(variables(paint))) if (value !== null) style[name] = value;
  const names = Object.entries(classes(paint)).flatMap(([name, on]) => (on ? [name] : []));
  return { className: names.join(' '), style: style as CSSProperties };
}

/** A card's colored edge for its record's color. */
export function edgeProps(record: RecordPaint | null): { className?: string; style?: CSSProperties } {
  return record
    ? { className: 'rio-color-edge', style: { '--rio-color-edge': lineColor(record.color) } as CSSProperties }
    : {};
}

/** Screen reader text naming the rules behind a color, or undefined when none apply. */
export function colorDescription(labels: readonly string[], locale: string): string | undefined {
  if (!labels.length) return undefined;
  if (labels.length === 1) return labels[0];
  try {
    return new Intl.ListFormat(locale, { type: 'unit', style: 'short' }).format(labels);
  } catch {
    return labels.join(', ');
  }
}
