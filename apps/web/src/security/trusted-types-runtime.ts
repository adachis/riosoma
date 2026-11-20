interface Boundaries {
  html(input: unknown): string;
  attribute(element: Element, name: string, value: string): string;
}

let boundaries: Boundaries | undefined;

/** Only the policy module installs these boundaries, after its sanitizer has loaded. */
export function installTrustedTypesBoundaries(value: Boundaries): void {
  boundaries ??= value;
}

/** React may forward HTML only after a caller has loaded the central sanitizer. */
export function runtimeHTML(input: unknown): string {
  if (!boundaries) throw new TypeError('The HTML sanitizer has not loaded');
  return boundaries.html(input);
}

/** Ordinary attributes do not load the parser, and sensitive attributes fail closed until ready. */
export function runtimeAttribute(element: Element, name: string, value: string): string {
  const attribute = name.toLowerCase();
  if (
    attribute === 'srcdoc' ||
    (element.nodeName.toLowerCase() === 'script' && ['src', 'text'].includes(attribute))
  ) {
    if (!boundaries) throw new TypeError('The attribute sanitizer has not loaded');
    return boundaries.attribute(element, name, value);
  }
  return value;
}

/** Preserve the receiver and evaluate each dependency argument once. */
export function setRuntimeAttribute(element: Element, name: string, value: string): void {
  element.setAttribute(name, runtimeAttribute(element, name, value));
}
