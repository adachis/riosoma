import { i18n } from '@lingui/core';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { patchTreeWalkerPreviousNode } from './tree-walker';

// Components render their English source messages when no catalog is loaded.
i18n.load('en-US', {});
i18n.activate('en-US');

patchTreeWalkerPreviousNode();

/*
 * Testing Library only drains its own microtask queue while timers are faked when it finds a
 * Jest-style global to advance them with.  Vitest fakes timers the same way, so it gets the same
 * hook; without it every awaited interaction would wait on a timer nothing can fire.
 */
Object.assign(globalThis, {
  jest: { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) },
});

afterEach(() => cleanup());
