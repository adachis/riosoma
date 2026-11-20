import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSelectionChangeFidelity } from './selection';

// The setup file installs this for every test file.  Installing it again here says what these
// tests are about, and a second call changes nothing.
installSelectionChangeFidelity();

/** The paragraphs a test added, taken back out so the next one starts from an empty page. */
const added: HTMLElement[] = [];

afterEach(() => {
  added.splice(0).forEach((node) => node.remove());
  document.getSelection()?.removeAllRanges();
});

function text(body: string): Text {
  const paragraph = document.createElement('p');
  const content = document.createTextNode(body);
  paragraph.append(content);
  document.body.append(paragraph);
  added.push(paragraph);
  return content;
}

describe('selection changes in tests', () => {
  it('hears a listener that puts the selection back once, not until the stack gives out', () => {
    const content = text('Departure day');
    const heard = vi.fn();
    // A date segment answers the event by collapsing the selection into itself again.  When the
    // emulator dispatched the event from inside that collapse, the listener called itself until
    // the stack ran out, and the page threw where nothing caught it.
    const listener = (): void => {
      heard();
      document.getSelection()?.collapse(content, 0);
    };
    document.addEventListener('selectionchange', listener);
    try {
      document.getSelection()?.collapse(content, 0);
    } finally {
      document.removeEventListener('selectionchange', listener);
    }
    expect(heard).toHaveBeenCalledTimes(1);
    // The selection still moved, so a test can read what a person would see.
    expect(document.getSelection()?.anchorNode).toBe(content);
    expect(document.getSelection()?.anchorOffset).toBe(0);
  });

  it('stays quiet when a mutation leaves the selection where it was', () => {
    const content = text('Cabin');
    const heard = vi.fn();
    document.addEventListener('selectionchange', heard);
    try {
      document.getSelection()?.collapse(content, 0);
      document.getSelection()?.collapse(content, 0);
      document.getSelection()?.collapse(content, 0);
    } finally {
      document.removeEventListener('selectionchange', heard);
    }
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('is heard for each move, including one back to no selection at all', () => {
    const from = text('From');
    const to = text('To');
    const heard = vi.fn();
    document.addEventListener('selectionchange', heard);
    try {
      document.getSelection()?.collapse(from, 0);
      document.getSelection()?.collapse(to, 0);
      document.getSelection()?.removeAllRanges();
    } finally {
      document.removeEventListener('selectionchange', heard);
    }
    expect(heard).toHaveBeenCalledTimes(3);
    expect(document.getSelection()?.rangeCount).toBe(0);
  });

  it('passes on an event a test dispatches itself', () => {
    const heard = vi.fn();
    document.addEventListener('selectionchange', heard);
    document.addEventListener('focusin', heard);
    try {
      document.dispatchEvent(new Event('focusin'));
      // A dispatched event is the test's own, so it is never the one held back here.
      document.dispatchEvent(new Event('selectionchange'));
      document.dispatchEvent(new Event('selectionchange'));
    } finally {
      document.removeEventListener('selectionchange', heard);
      document.removeEventListener('focusin', heard);
    }
    expect(heard).toHaveBeenCalledTimes(3);
  });
});
