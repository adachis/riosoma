import type { MouseEvent } from 'react';

export function navigateOnPlainClick(event: MouseEvent<HTMLAnchorElement>, onNavigate: () => void) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return;
  event.preventDefault();
  onNavigate();
}
