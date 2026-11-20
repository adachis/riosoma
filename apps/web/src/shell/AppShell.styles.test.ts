import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'AppShell.css'), 'utf8');

/** What the shell's own rule declares, before the rules for its parts. */
const shell = /\.rio-shell \{([^}]*)\}/.exec(css)?.[1] ?? '';

it('clips the page to the window, including what a control hides off to the side', () => {
  expect(shell).toContain('block-size: 100dvh');
  expect(shell).toContain('overflow: hidden');
  expect(shell).toContain('overflow: clip');
  expect(shell.lastIndexOf('overflow: clip')).toBeGreaterThan(shell.lastIndexOf('overflow: hidden'));
  // A switch's or checkbox's own input is absolutely positioned and invisible.  Without a placed
  // ancestor it takes the page as its containing block, escapes the clip, and stretches what the
  // window can scroll to, so the shell has to be that ancestor.
  expect(shell).toContain('position: relative');
});
