import { faCheck } from '@fortawesome/free-solid-svg-icons';
import type { IconDefinition } from '@riosoma/icons';

export function span(document: Document, className: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  return node;
}

export function icon(document: Document, definition: IconDefinition): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const [width, height, , , data] = definition.icon;
  svg.setAttribute('class', 'rio-icon');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '1em');
  svg.setAttribute('height', '1em');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of Array.isArray(data) ? data : [data]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
}

export function checkbox(document: Document): HTMLSpanElement {
  const box = span(document, 'rio-cell-check');
  box.setAttribute('aria-hidden', 'true');
  box.append(icon(document, faCheck));
  return box;
}

export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
