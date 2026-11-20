import type { DOMPurify as Purifier, WindowLike } from 'dompurify';
import { i18n } from '@lingui/core';
import { SOURCE_LOCALE } from '@riosoma/i18n';
import { configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { installSelectionChangeFidelity } from './test/selection';
import { watchUncaughtErrors } from './test/uncaught';

// DOMPurify requires native DOM invariants that Happy DOM does not implement.  Use its real
// sanitizer with JSDOM in unit tests, while browser tests exercise the page's own DOM and policy.
vi.mock('dompurify', async (original) => {
  const { default: createDOMPurify } = await original<{ default: Purifier }>();
  const { JSDOM } = await import('jsdom');
  return { default: createDOMPurify(new JSDOM('').window as unknown as WindowLike) };
});

// A busy machine (the whole workspace testing in parallel) can take well over a second to show what
// a test waits for.  Waiting longer costs nothing when it passes, and only slows a real failure.
configure({ asyncUtilTimeout: 5_000 });

// Much of the page reads the app's own i18n instance outside React, and finds a locale there
// because the entry point loads one before the first render.  Tests render under a provider of
// their own, so the shared instance would have no locale, and a message about a failure would
// throw inside the very code that was reporting the failure.  An empty catalog is enough: a test
// that cares about wording brings its own.
if (!i18n.locale) {
  i18n.load(SOURCE_LOCALE, {});
  i18n.activate(SOURCE_LOCALE);
}

// The emulator's selection events re-enter the listeners that answer them, which a browser's do
// not.  Without this, a focused date segment overflows the stack.  A test that runs outside a
// page, such as a service worker's, has no selection to keep honest.
if (typeof window !== 'undefined') installSelectionChangeFidelity(window);

// An error nothing caught and a promise nothing answered used to end here, in silence, so a page
// that would break in use could still pass its tests.  Fail the test they escaped from instead.
const uncaught = watchUncaughtErrors();
afterEach(() => {
  const escaped = uncaught.take();
  if (escaped.length === 0) return;
  const count = escaped.length === 1 ? 'An uncaught error' : `${escaped.length} uncaught errors`;
  throw new Error(
    `${count} escaped this test, and nothing caught it:\n\n${escaped.join('\n\n')}\n\n` +
      'The page would be broken here in use, so the test cannot pass on it.',
  );
});
