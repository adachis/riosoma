import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, test as baseTest, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { AccessibilityBudget, accessibilityDeadline, accessibilityScanTimeout } from './base';
import { recordLayoutAudit } from './tight-space-audit';

export * from '@playwright/test';

let reportSequence = 0;
const axeDocuments = new WeakMap<Page, string>();

/** Document identity detects navigation without depending on clock precision. */
export async function documentIdentity(page: Page): Promise<string> {
  return page.evaluate((identity) => {
    const key = Symbol.for('rio.accessibility.document');
    const previous: unknown = Reflect.get(document, key);
    if (typeof previous === 'string') return previous;
    Object.defineProperty(document, key, { value: identity });
    return identity;
  }, randomUUID());
}

/** Text and the hidden fallback alone do not give an app document a screen to scan. */
function appContentProblem(): string | undefined {
  const root = document.getElementById('root');
  if (!root) return;
  if ([...root.children].some((child) => child.id !== 'rio-startup-error' || !child.hasAttribute('hidden')))
    return;
  return root.children.length ? '#root holds only the hidden startup recovery screen' : '#root is empty';
}

interface ContentWait {
  problem?: string;
  url?: string;
}

function scanTimeout(page: Page, content: ContentWait): Error {
  return new Error(
    content.problem
      ? `No rendered app content at ${content.url}: ${content.problem}`
      : `Accessibility scan timed out at ${page.url()}`,
  );
}

async function waitForAppContent(page: Page, deadline: number, content: ContentWait): Promise<void> {
  for (;;) {
    if (Date.now() >= deadline) throw scanTimeout(page, content);
    content.problem = await page.evaluate(appContentProblem);
    content.url = page.url();
    if (Date.now() >= deadline) throw scanTimeout(page, content);
    if (!content.problem) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  }
}

// The accessible tree retains tabs, dialogs, and expanded controls without hover decoration.
async function screenCoverage(
  page: Page,
  deadline: number,
): Promise<{ key: string; settled: boolean; documentId: string }> {
  // Field values and status values such as save progress or zoom do not open another screen.
  // Labels, validation alerts, selected or expanded states, and new controls still change coverage.
  const tree = (await page.locator('body').ariaSnapshot({ timeout: Math.max(1, deadline - Date.now()) }))
    .split('\n')
    .map((line) =>
      line.replace(
        /^(\s*- (?:textbox|searchbox|spinbutton|combobox|status)(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*): .+$/,
        '$1',
      ),
    )
    .join('\n');
  const screen = await page.evaluate((identity) => {
    const key = Symbol.for('rio.accessibility.document');
    if (!Reflect.has(document, key)) Object.defineProperty(document, key, { value: identity });
    const documentId = Reflect.get(document, key) as string;
    return {
      documentId,
      context: `${documentId}:${innerWidth}:${innerHeight}:${document.documentElement.dataset.theme}:${document.documentElement.dataset.scheme}:${document.documentElement.dataset.mode}:${document.documentElement.dataset.surface}:${matchMedia('(forced-colors: active)').matches}`,
      settled:
        document.readyState !== 'loading' &&
        document.fonts.status === 'loaded' &&
        !document.querySelector('.rio-feature-loading') &&
        !document.querySelector('[data-entering], [data-exiting]') &&
        [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].every(
          (link) => link.sheet,
        ) &&
        !document.getAnimations().some((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          return (
            animation.playState === 'running' &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
            !(target instanceof Element && target.closest('[aria-hidden="true"]'))
          );
        }),
    };
  }, randomUUID());
  return {
    key: `${page.url()}:${screen.context}:${tree}`,
    settled: screen.settled && !(await page.evaluate(appContentProblem)),
    documentId: screen.documentId,
  };
}

function navigationInterrupted(error: unknown): boolean {
  return /Execution context was destroyed|Cannot find context with specified id/.test(String(error));
}

async function settled(page: Page, deadline: number): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - Date.now()) });
  // PDF viewers can keep a frame loading indefinitely.  Readiness belongs to the app document.
  await page.waitForFunction(
    () =>
      document.readyState !== 'loading' &&
      !!document.body &&
      document.fonts.status === 'loaded' &&
      !document.querySelector('.rio-feature-loading') &&
      !document.querySelector('[data-entering], [data-exiting]') &&
      [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].every((link) => link.sheet),
    undefined,
    { timeout: Math.max(1, deadline - Date.now()) },
  );
  await page.waitForFunction(
    async () => {
      // Effects can start an animation on the next frame after an action returns.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return true;
    },
    undefined,
    { timeout: Math.max(1, deadline - Date.now()) },
  );
  // Poll current state: offscreen illustrations can pause an animation after it was running.
  // Finishing an overlay animation can also schedule its unmount on the next render.
  await page.waitForFunction(
    () =>
      !document.querySelector('.rio-feature-loading') &&
      !document.querySelector('[data-entering], [data-exiting]') &&
      !document.getAnimations().some((animation) => {
        // Decorative branding does not delay accessibility of the controls around it.
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return (
          animation.playState === 'running' &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
          !(target instanceof Element && target.closest('[aria-hidden="true"]'))
        );
      }),
    undefined,
    { timeout: Math.max(1, deadline - Date.now()) },
  );
}

export async function assertAccessible(
  page: Page,
  covered = new Set<string>(),
  deadline = Date.now() + accessibilityScanTimeout,
  productOnly = false,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const content: ContentWait = {};
  try {
    return await Promise.race([
      scanAccessible(page, covered, deadline, productOnly, content),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(scanTimeout(page, content)), Math.max(1, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function scanAccessible(
  page: Page,
  covered: Set<string>,
  deadline: number,
  productOnly: boolean,
  content: ContentWait,
): Promise<string> {
  for (;;) {
    if (Date.now() >= deadline) throw scanTimeout(page, content);
    try {
      // A complete document can still be waiting for startup requests before mounting React.
      // Keep its last observed state available to the outer timer at the same deadline.
      await waitForAppContent(page, deadline, content);
      // Already checked states need no font or animation waits while their document is settled.
      // This lookup stays inside the navigation retry, unlike an unguarded preliminary snapshot.
      if (covered.size) {
        const previous = await screenCoverage(page, deadline);
        if (previous.settled && covered.has(previous.key)) return previous.key;
      }
      // Public documents can disable scripts, which also stops animation frame callbacks.
      // Their dedicated scans run separately from the application navigation checks.
      await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - Date.now()) });
      await waitForAppContent(page, deadline, content);
      // A redirect can commit after this gate, so the gate first records which document it is
      // about to accept.  Reading the identity afterwards would name the replacement instead.
      let gated: string | undefined;
      if (productOnly) {
        gated = await documentIdentity(page);
        if (
          !(await page.evaluate(
            () => !!document.getElementById('root') || location.protocol === 'chrome-extension:',
          ))
        )
          return '';
      }
      await settled(page, deadline);
      const { key: coverage, documentId, settled: ready } = await screenCoverage(page, deadline);
      // Rendering can start another overlay between the readiness poll and this snapshot.
      if (!ready) continue;
      if (covered.has(coverage)) return coverage;
      // Reuse axe only in a document already analyzed without frames.  Frame-aware analysis
      // still injects into every frame, including frames mounted since the preceding scan.
      const singleDocument =
        page.frames().length === 1 && (await page.locator('iframe, frame').count()) === 0;
      const analyzer = (reuse: boolean) =>
        new AxeBuilder({
          page,
          ...(reuse ? { axeSource: 'void 0;' } : {}),
        })
          // Keep every violation node.  Passing node details only enlarge the report and trace.
          .options({ resultTypes: ['violations'] })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          // A navigation may leave a spoken announcement referring to a control that has gone away.
          .exclude('[data-live-announcer]');
      // A single document runs every rule without a separate frame-merging page.
      let results = await analyzer(singleDocument && axeDocuments.get(page) === documentId)
        .setLegacyMode(singleDocument)
        .analyze();
      // A frame mounted during analysis still receives the complete frame-aware scan.
      if (singleDocument && (page.frames().length > 1 || (await page.locator('iframe, frame').count()) > 0)) {
        results = await analyzer(false).setLegacyMode(false).analyze();
      }
      if (singleDocument) axeDocuments.set(page, documentId);
      if (Date.now() >= deadline) throw new Error('Accessibility scan exceeded its deadline');
      // Rendering can open an overlay while axe is reading styles.  Those transient results
      // belong to neither settled state.  Scan the replacement before asserting its contrast.
      const current = await screenCoverage(page, deadline);
      if (!current.settled || current.key !== coverage) continue;
      // A redirect that commits after the gate leaves results from a document this scan never
      // accepted.  Loop again so the gate decides what the replacement page needs.
      if (gated !== undefined && current.documentId !== gated) continue;
      const info = baseTest.info();
      const file = info.outputPath(`accessibility-${reportSequence++}.json`);
      await writeFile(file, JSON.stringify({ url: page.url(), violations: results.violations }, null, 2));
      await info.attach('accessibility', { path: file, contentType: 'application/json' });
      expect
        .soft(
          results.violations.map((v) => ({
            rule: v.id,
            targets: v.nodes.map((n) => n.target),
            reasons: v.nodes.map((n) => n.failureSummary),
          })),
          `Accessibility at ${page.url()}`,
        )
        .toEqual([]);
      covered.add(coverage);
      // Async rendering during axe's work does not count as coverage of the replacement state.
      if ((await screenCoverage(page, deadline)).key !== coverage) continue;
      return coverage;
    } catch (error) {
      if (!navigationInterrupted(error)) throw error;
      // Redirects replace the document, so retry the entire settled-state scan on the new page.
    }
  }
}

function replace<T extends object, K extends keyof T>(
  restore: Array<() => void>,
  target: T,
  key: K,
  value: T[K],
): void {
  const original = target[key];
  target[key] = value;
  restore.push(() => {
    target[key] = original;
  });
}

/** Navigation checks are shared by every feature spec, including its extra browser contexts. */
export const test = baseTest.extend<{ accessibilityChecks: (context: BrowserContext) => void }>({
  accessibilityChecks: [
    async ({ browser, page, context }, use, info) => {
      const restore: Array<() => void> = [];
      // Instrumentation would change the timing measurements; performance has its own isolated config.
      if (info.project.name === 'performance') {
        await use(() => {});
        return;
      }
      const scanned = new WeakMap<Page, Set<string>>();
      const attached = new WeakSet<BrowserContext>();
      const contexts: BrowserContext[] = [];
      const started = Date.now();
      const budget = new AccessibilityBudget(info, started);
      let teardownDeadline: number | undefined;
      const scan = async (target: Page) => {
        if (target.isClosed() || !/^(?:https?|chrome-extension):/.test(target.url())) return;
        await budget.run(async (deadline) => {
          // Retry includes readiness and coverage.  Neither reads a navigating document early.
          const covered = scanned.get(target) ?? new Set<string>();
          const previousStates = covered.size;
          await assertAccessible(target, covered, deadline, true);
          scanned.set(target, covered);
          if (process.env.RIOSOMA_LAYOUT_AUDIT && covered.size > previousStates) {
            await recordLayoutAudit(target, info, `state-${covered.size}`, target, {
              reportOnly: process.env.RIOSOMA_LAYOUT_AUDIT === 'report',
            });
          }
        }, teardownDeadline);
      };
      const attachPage = (target: Page) => {
        const goto = target.goto.bind(target);
        replace(restore, target, 'goto', async (...args) => {
          await scan(target);
          const response = await goto(...args);
          await scan(target);
          return response;
        });
        const reload = target.reload.bind(target);
        replace(restore, target, 'reload', async (...args) => {
          await scan(target);
          const response = await reload(...args);
          await scan(target);
          return response;
        });
        const close = target.close.bind(target);
        replace(restore, target, 'close', async (...args) => {
          await scan(target);
          return close(...args);
        });
        const press = target.keyboard.press.bind(target.keyboard);
        replace(restore, target.keyboard, 'press', async (...args) => {
          await scan(target);
          await press(...args);
          await scan(target);
        });
      };
      const attachContext = (target: BrowserContext) => {
        if (attached.has(target)) return;
        attached.add(target);
        contexts.push(target);
        for (const existing of target.pages()) attachPage(existing);
        target.on('page', attachPage);
        restore.push(() => {
          target.off('page', attachPage);
        });
        const close = target.close.bind(target);
        replace(restore, target, 'close', async (...args) => {
          for (const opened of target.pages()) await scan(opened);
          return close(...args);
        });
      };
      attachContext(context);
      const newContext = browser.newContext.bind(browser);
      replace(restore, browser, 'newContext', async (...args) => {
        const created = await newContext(...args);
        attachContext(created);
        return created;
      });
      // SPA navigation and the Firefox visit helper don't necessarily call Page.goto.
      const prototype = Object.getPrototypeOf(page.locator('body')) as Locator;
      for (const action of ['click', 'dblclick', 'tap', 'fill', 'press', 'check', 'selectOption'] as const) {
        const original = prototype[action];
        replace(
          restore,
          prototype,
          action,
          new Proxy(original, {
            async apply(method, locator: Locator, args: unknown[]) {
              await scan(locator.page());
              const result: unknown = await Reflect.apply(method, locator, args);
              await scan(locator.page());
              return result;
            },
          }),
        );
      }
      try {
        await use(attachContext);
      } finally {
        try {
          teardownDeadline = accessibilityDeadline(info, started);
          for (const opened of contexts.flatMap((context) => context.pages())) await scan(opened);
        } finally {
          for (const undo of restore.reverse()) undo();
        }
      }
    },
    { auto: true },
  ],
});
