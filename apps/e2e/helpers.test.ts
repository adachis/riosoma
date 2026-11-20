import { EventEmitter } from 'node:events';
import type { Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import { documentIdentity } from './accessibility';
import { labelName, visit } from './helpers';

vi.mock('./accessibility', () => ({ documentIdentity: vi.fn() }));
vi.mock('./stack', () => ({ SETUP_TOKEN: 'test-setup' }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const destination = 'http://127.0.0.1:4321/setup';
const bootRequest = 'http://127.0.0.1:4321/assets/runtime.js';
const networkChanged = 'net::ERR_NETWORK_CHANGED';

function browserPage(browser = 'chromium') {
  const events = new EventEmitter();
  const dispose = vi.fn(async () => {});
  const goto = vi.fn(async (_url: string, _options?: unknown) => null);
  const evaluate = vi.fn(async (_fn: unknown, _arg?: unknown) => undefined);
  const waitForFunction = vi.fn(
    async (_fn: unknown, _arg?: unknown, _options?: { signal?: AbortSignal }) => ({ dispose }),
  );
  vi.mocked(documentIdentity).mockResolvedValue('previous-document');
  const page = Object.assign(events, {
    goto,
    evaluate,
    waitForFunction,
    context: () => ({ browser: () => ({ browserType: () => ({ name: () => browser }) }) }),
    url: () => destination,
  }) as unknown as Page;
  return {
    page,
    events,
    goto,
    evaluate,
    waitForFunction,
    dispose,
    fail(url = bootRequest, errorText = networkChanged) {
      events.emit('requestfailed', { url: () => url, failure: () => ({ errorText }) });
    },
  };
}

function interruptedReadiness(fixture: ReturnType<typeof browserPage>, url = bootRequest) {
  fixture.waitForFunction.mockImplementationOnce((_fn, _arg, options) => {
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('Readiness canceled')), {
        once: true,
      });
      fixture.fail(url);
      // A lost boot script never makes the app ready.  Reject on the next turn so broken
      // recovery fails this test immediately instead of consuming the unit test deadline.
      setImmediate(() => reject(new Error('App never mounted')));
    });
  });
}

it('navigates again once when a destination boot request is lost before app readiness', async () => {
  const fixture = browserPage();
  interruptedReadiness(fixture);
  await visit(fixture.page, destination);
  expect(fixture.goto.mock.calls.map(([url]) => url)).toEqual([destination, destination]);
  expect(fixture.dispose).toHaveBeenCalledOnce();
  expect(fixture.events.listenerCount('requestfailed')).toBe(0);
});

it('reports the failed URL and network error immediately when the second visit is interrupted', async () => {
  const fixture = browserPage();
  interruptedReadiness(fixture);
  const failedAgain = 'http://127.0.0.1:4321/startup-recovery.js';
  interruptedReadiness(fixture, failedAgain);
  const error = await visit(fixture.page, destination).catch((error: unknown) => error);
  expect(String(error)).toContain(failedAgain);
  expect(String(error)).toContain(networkChanged);
  expect(fixture.goto).toHaveBeenCalledTimes(2);
  expect(fixture.events.listenerCount('requestfailed')).toBe(0);
});

it('recovers when the document request itself fails before committing', async () => {
  const fixture = browserPage();
  fixture.goto.mockImplementationOnce(async () => {
    fixture.fail(destination);
    throw new Error(`page.goto: ${networkChanged} at ${destination}`);
  });
  await visit(fixture.page, destination);
  expect(fixture.goto).toHaveBeenCalledTimes(2);
  expect(fixture.events.listenerCount('requestfailed')).toBe(0);
});

it.each([
  ['another origin', 'https://fonts.example.test/font.woff2', networkChanged],
  ['another port', 'http://127.0.0.1:4322/assets/runtime.js', networkChanged],
  ['another error', bootRequest, 'net::ERR_CONNECTION_RESET'],
])('preserves readiness failures for %s', async (_reason, url, errorText) => {
  const fixture = browserPage();
  const failure = new Error('Existing readiness failure');
  fixture.waitForFunction.mockImplementationOnce(async () => {
    fixture.fail(url, errorText);
    throw failure;
  });
  await expect(visit(fixture.page, destination)).rejects.toBe(failure);
  expect(fixture.goto).toHaveBeenCalledOnce();
  expect(fixture.events.listenerCount('requestfailed')).toBe(0);
});

it.each(['firefox', 'webkit'])('retains %s navigation behavior on request failure', async (browser) => {
  const fixture = browserPage(browser);
  const failure = new Error('Existing readiness failure');
  fixture.waitForFunction.mockImplementationOnce(async () => {
    fixture.fail();
    throw failure;
  });
  await expect(visit(fixture.page, destination)).rejects.toBe(failure);
  expect(fixture.goto).toHaveBeenCalledTimes(browser === 'firefox' ? 0 : 1);
  expect(fixture.evaluate).toHaveBeenCalledTimes(browser === 'firefox' ? 1 : 0);
  expect(fixture.events.listenerCount('requestfailed')).toBe(0);
});

it('uses location.assign in Firefox and waits for a replacement document', async () => {
  const fixture = browserPage('firefox');
  const assign = vi.fn();
  vi.stubGlobal('window', { location: { assign } });
  fixture.evaluate.mockImplementationOnce(async (fn, arg) => {
    (fn as (arg: unknown) => void)(arg);
  });
  await visit(fixture.page, destination);
  expect(assign).toHaveBeenCalledWith(destination);
  expect(fixture.goto).not.toHaveBeenCalled();
  const [predicate, argument] = fixture.waitForFunction.mock.calls[0]!;
  const document = {
    readyState: 'complete',
    getElementById: () => null,
    [Symbol.for('rio.accessibility.document')]: 'previous-document',
  };
  vi.stubGlobal('document', document);
  const ready = predicate as (arg: unknown) => boolean;
  expect(ready(argument)).toBe(false);
  document[Symbol.for('rio.accessibility.document')] = 'replacement-document';
  expect(ready(argument)).toBe(true);
});

it('keeps the app readiness opt-out and disposes the readiness handle', async () => {
  const fixture = browserPage();
  await visit(fixture.page, destination, { waitForAppLoaded: false });
  const [predicate, argument] = fixture.waitForFunction.mock.calls[0]!;
  vi.stubGlobal('document', {
    readyState: 'complete',
    getElementById: () => ({ children: [{ id: 'rio-startup-error' }], querySelector: () => null }),
  });
  expect((predicate as (arg: unknown) => boolean)(argument)).toBe(true);
  expect(fixture.dispose).toHaveBeenCalledOnce();
  expect(fixture.events.listenerCount('requestfailed')).toBe(0);
});

it('removes the failure listener after a successful visit', async () => {
  const fixture = browserPage();
  await visit(fixture.page, destination);
  fixture.fail();
  await Promise.resolve();
  expect(fixture.goto).toHaveBeenCalledOnce();
  expect(fixture.events.listenerCount('requestfailed')).toBe(0);
});

it('matches a complete visible label while allowing accessible details after it', () => {
  const name = labelName('Reading list (2) + notes');
  expect(name.test('Reading list (2) + notes Books, Authors')).toBe(true);
  expect(name.test('Reading list (2) + notes')).toBe(true);
  expect(name.test('Reading list (2) + notesExtra')).toBe(false);
  expect(name.test('Reading list 2 + notes')).toBe(false);
});
