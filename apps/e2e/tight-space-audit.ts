import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
let layoutReportSequence = 0;

export type LayoutFindingKind =
  'overlap' | 'clipped' | 'wrapped' | 'outside' | 'text-action' | 'unnamed-icon' | 'missing-tooltip';
export interface LayoutFinding {
  kind: LayoutFindingKind;
  selector: string;
  related?: string;
  text: string;
  control?: string;
  relatedControl?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  relatedBounds?: { x: number; y: number; width: number; height: number };
}
export interface LayoutAllowance {
  kind: LayoutFindingKind;
  selector: string;
  reason: string;
}

/** Exceptions identify one control and explain the intentional presentation. */
export const layoutAllowlist: readonly LayoutAllowance[] = [
  {
    kind: 'clipped',
    selector: '.rio-grid__viewport .rio-cell-row-header__number',
    reason: 'A virtualized grid can show part of the next row at its scrolling viewport boundary.',
  },
  {
    kind: 'clipped',
    selector: '.rio-grid__pane .rio-cell-value--link',
    reason:
      'A virtualized link cell can cross a horizontally scrolling pane boundary.  The cell editor exposes its full value.',
  },
  {
    kind: 'clipped',
    selector: '.rio-grid__viewport .rio-cell-row-header__action',
    reason:
      'A virtualized grid can show part of the next row at its scrolling boundary.  Scrolling reveals the complete row actions.',
  },
  {
    kind: 'text-action',
    selector: '.rio-units__grow',
    reason: 'The control displays an organization unit name, which a person can name freely.',
  },
  {
    kind: 'text-action',
    selector: '.rio-units__edit',
    reason: 'Rename or move names two choices in the unit editor, and one icon cannot identify both.',
  },
  {
    kind: 'text-action',
    selector: '.rio-db-header__name button',
    reason: 'The button displays a database name, which a person can name freely.',
  },
  {
    kind: 'outside',
    selector: '.rio-scan-picker__corner',
    reason: 'The crop target is centered on the page edge inside the surrounding padded dialog.',
  },
  {
    kind: 'text-action',
    selector: '.rio-db-view-switcher',
    reason: 'The control displays the selected view name, which a person can name freely.',
  },
  {
    kind: 'text-action',
    selector: '.rio-folder-row__name',
    reason: 'The control displays a folder name, which a person can name freely.',
  },
  {
    kind: 'text-action',
    selector: '.rio-script-list__open',
    reason: 'The control displays a saved script name, which a person can name freely.',
  },
  {
    kind: 'text-action',
    selector: '.rio-plan-preview__targets .rio-button',
    reason:
      'The control displays a proposed view, automation, dashboard, or interface page name, which a person can name freely.',
  },
  {
    kind: 'text-action',
    selector: '.rio-calendar-view__chip',
    reason: 'The control displays a record name, which a person can name freely.',
  },
  {
    kind: 'text-action',
    selector: '.rio-assistant__header .rio-select__trigger',
    reason: 'The picker displays the current conversation name, including an unnamed conversation.',
  },
  {
    kind: 'text-action',
    selector: '.rio-dialog__footer .rio-button',
    reason: 'Dialog answers need words to state the choice and its consequences.',
  },
  {
    kind: 'text-action',
    selector: 'button[type="submit"]',
    reason: 'Form submission remains a named primary action.',
  },
  {
    kind: 'text-action',
    selector: '.rio-synced-status__review',
    reason: 'Reviewing source removals requires a specific decision rather than an immediate remove icon.',
  },
];

/** Reads actual rendered bounds, including clipping ancestors and text line boxes. */
export async function auditTightSpaces(
  scope: Page | Locator,
  allowances: readonly LayoutAllowance[] = layoutAllowlist,
): Promise<LayoutFinding[]> {
  for (const allowance of allowances) {
    if (!allowance.reason.trim()) throw new Error(`Layout allowance needs a reason: ${allowance.selector}`);
  }
  const root = 'viewportSize' in scope ? scope.locator('body') : scope;
  return root.evaluate(
    (container, allowances) => {
      const findings: LayoutFinding[] = [];
      const tolerance = 2;
      const overlaySelector =
        '[role="dialog"], [role="menu"], .rio-popover, .rio-toast, .rio-record-surface--panel, .rio-timeline-chart__side, .rio-automation-canvas__note, .rio-script-panel, .rio-assistant__dock, .rio-grid-find, .rio-demo-card';
      const selector = (element: Element): string => {
        if (element.id) return `#${CSS.escape(element.id)}`;
        const path: string[] = [];
        let current: Element | null = element;
        while (current && current !== container) {
          const siblings: Element[] = current.parentElement ? [...current.parentElement.children] : [];
          const tag = current.tagName.toLowerCase();
          const classes = [...current.classList]
            .filter((name) => name.startsWith('rio-'))
            .slice(0, 2)
            .map((name) => `.${CSS.escape(name)}`)
            .join('');
          path.unshift(`${tag}${classes}:nth-child(${siblings.indexOf(current) + 1})`);
          current = current.parentElement;
        }
        return path.join(' > ') || ':scope';
      };
      const visible = (element: Element): boolean => {
        const closedDetails = element.closest('details:not([open])');
        if (closedDetails && !closedDetails.querySelector(':scope > summary')?.contains(element))
          return false;
        const rect = element.getBoundingClientRect();
        if (
          rect.width < 2 ||
          rect.height < 2 ||
          rect.right < 0 ||
          rect.bottom < 0 ||
          rect.left > innerWidth ||
          rect.top > innerHeight
        )
          return false;
        for (let parent: Element | null = element; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0 ||
            (style.clipPath !== 'none' && parent.getBoundingClientRect().width < 2) ||
            parent.hasAttribute('hidden')
          )
            return false;
          if (/hidden|clip|auto|scroll/.test(style.overflowX + style.overflowY)) {
            const box = parent.getBoundingClientRect();
            if (
              (/hidden|clip|auto|scroll/.test(style.overflowX) &&
                (rect.right <= box.left || rect.left >= box.right)) ||
              (/hidden|clip|auto|scroll/.test(style.overflowY) &&
                (rect.bottom <= box.top || rect.top >= box.bottom))
            )
              return false;
          }
        }
        return true;
      };
      const text = (element: Element) =>
        (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
      const add = (kind: LayoutFindingKind, element: Element, related?: Element) => {
        if (allowances.some((entry) => entry.kind === kind && element.matches(entry.selector))) return;
        const finding = {
          kind,
          selector: selector(element),
          text: text(element) || element.getAttribute('aria-label') || element.getAttribute('title') || '',
          control: `${element.tagName.toLowerCase()}.${[...element.classList].filter((name) => name.startsWith('rio-')).join('.')}`,
          bounds: element.getBoundingClientRect().toJSON(),
          ...(related ? { related: selector(related) } : {}),
          ...(related
            ? {
                relatedControl: `${related.tagName.toLowerCase()}.${[...related.classList].filter((name) => name.startsWith('rio-')).join('.')}`,
              }
            : {}),
          ...(related ? { relatedBounds: related.getBoundingClientRect().toJSON() } : {}),
        };
        if (
          !findings.some(
            (entry) =>
              entry.kind === kind && entry.selector === finding.selector && entry.related === finding.related,
          )
        )
          findings.push(finding);
      };
      const ellipsis = (element: Element) =>
        getComputedStyle(element).textOverflow === 'ellipsis' ||
        (getComputedStyle(element).getPropertyValue('-webkit-line-clamp') !== 'none' &&
          getComputedStyle(element).getPropertyValue('-webkit-line-clamp') !== '');
      const interactive = [
        ...container.querySelectorAll<HTMLElement>(
          'button, input:not([type="hidden"]), textarea, select, a[href], [role="button"], [role="combobox"], [role="checkbox"], [role="switch"], [role="slider"]',
        ),
      ]
        .filter(visible)
        .filter((element) => !element.closest('[aria-hidden="true"], [inert]'))
        .filter((element) => {
          const style = getComputedStyle(element);
          // Visually hidden inputs are represented by their visible checkbox or switch labels.
          return style.clipPath === 'none' && style.pointerEvents !== 'none';
        });
      const paintedBounds = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const bounds = {
          left: Math.max(0, rect.left),
          top: Math.max(0, rect.top),
          right: Math.min(innerWidth, rect.right),
          bottom: Math.min(innerHeight, rect.bottom),
        };
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const box = parent.getBoundingClientRect();
          if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
            bounds.left = Math.max(bounds.left, box.left);
            bounds.right = Math.min(bounds.right, box.right);
          }
          if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
            bounds.top = Math.max(bounds.top, box.top);
            bounds.bottom = Math.min(bounds.bottom, box.bottom);
          }
        }
        return bounds;
      };
      // Bounds stay fixed during this read-only scan, so each control needs one clipping walk.
      const painted = interactive.map(paintedBounds);
      for (let i = 0; i < interactive.length; i++) {
        const element = interactive[i]!;
        const bounds = painted[i]!;
        for (let otherIndex = i + 1; otherIndex < interactive.length; otherIndex++) {
          const other = interactive[otherIndex]!;
          if (element.contains(other) || other.contains(element)) continue;
          const box = painted[otherIndex]!;
          if (
            Math.min(bounds.right, box.right) - Math.max(bounds.left, box.left) > tolerance &&
            Math.min(bounds.bottom, box.bottom) - Math.max(bounds.top, box.top) > tolerance
          ) {
            // Controls covered by a modal, popover, or temporary toast belong to another layer.
            const x = (Math.max(bounds.left, box.left) + Math.min(bounds.right, box.right)) / 2;
            const y = (Math.max(bounds.top, box.top) + Math.min(bounds.bottom, box.bottom)) / 2;
            const front = document.elementFromPoint(x, y);
            if (
              front &&
              (element.contains(front) || other.contains(front)) &&
              element.closest(overlaySelector) === other.closest(overlaySelector)
            )
              add('overlap', element, other);
          }
        }
        const content = text(element);
        const labelled = element
          .getAttribute('aria-labelledby')
          ?.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
        const name =
          element.getAttribute('aria-label')?.trim() ||
          labelled ||
          content ||
          element.getAttribute('title')?.trim();
        const icon =
          element.matches('button, [role="button"]') && element.querySelector('svg, .rio-icon') && !content;
        if (icon && !name) add('unnamed-icon', element);
        if (
          icon &&
          !element.getAttribute('title') &&
          !element.getAttribute('data-tooltip') &&
          !element
            .getAttribute('aria-describedby')
            ?.split(/\s+/)
            .some((id) => document.getElementById(id)?.getAttribute('role') === 'tooltip')
        )
          add('missing-tooltip', element);
        const tight = element.closest(
          'nav, aside, header, [role="toolbar"], [role="row"], [role="cell"], td, th, .rio-toolbar, .rio-view-row, .rio-folder-row, [class*="__header"], [class*="__heading"], [class*="__row"], [class*="__chip"], [class*="inline"], [class*="panel"]',
        );
        if (
          tight &&
          element.matches('button, [role="button"]') &&
          /^(?:add|new|delete|remove|close|rename|edit|duplicate|settings|expand|collapse|more|refresh|copy|download|upload|sign out)(?:\s|$)/i.test(
            content,
          )
        )
          add('text-action', element);
        const rect = element.getBoundingClientRect();
        const rectangle = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor === document.body || ancestor === document.documentElement) break;
          const clipping = getComputedStyle(ancestor);
          const box = ancestor.getBoundingClientRect();
          // Native scrolling crops its current view, while outer containers can still clip it.
          if (/auto|scroll/.test(clipping.overflowX)) {
            rectangle.left = Math.max(rectangle.left, box.left);
            rectangle.right = Math.min(rectangle.right, box.right);
          }
          if (/auto|scroll/.test(clipping.overflowY)) {
            rectangle.top = Math.max(rectangle.top, box.top);
            rectangle.bottom = Math.min(rectangle.bottom, box.bottom);
          }
          if (
            (/hidden|clip/.test(clipping.overflowX) &&
              (rectangle.left < box.left - tolerance || rectangle.right > box.right + tolerance)) ||
            (/hidden|clip/.test(clipping.overflowY) &&
              (rectangle.top < box.top - tolerance || rectangle.bottom > box.bottom + tolerance))
          )
            add('clipped', element, ancestor);
        }
        const parent = element.parentElement;
        if (
          parent &&
          getComputedStyle(parent).display !== 'contents' &&
          !/auto|scroll/.test(getComputedStyle(parent).overflowX)
        ) {
          const box = parent.getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          if (
            box.width >= 2 &&
            box.height >= 2 &&
            (bounds.left < box.left - tolerance ||
              bounds.right > box.right + tolerance ||
              bounds.top < box.top - tolerance ||
              bounds.bottom > box.bottom + tolerance)
          )
            add('outside', element, parent);
        }
      }
      for (const element of container.querySelectorAll<HTMLElement>('*')) {
        if (
          !visible(element) ||
          element.closest('svg, [aria-hidden="true"], [inert]') ||
          /^(SCRIPT|STYLE|OPTION)$/.test(element.tagName)
        )
          continue;
        const style = getComputedStyle(element);
        if (style.clipPath !== 'none') continue;
        const range = document.createRange();
        const lines: DOMRect[] = [];
        for (const node of element.childNodes)
          if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
            range.selectNodeContents(node);
            lines.push(...range.getClientRects());
          }
        if (!lines.length) continue;
        const control = element.closest('button, [role="button"]');
        if (
          control &&
          new Set(lines.map((line) => Math.round(line.top))).size > 1 &&
          !control.closest('[role="menu"]')
        )
          add('wrapped', control);
        if (ellipsis(element)) continue;
        for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
          if (ellipsis(parent)) break;
          // A temporary scroll lock still crops the page at the window's edge.
          if (parent === document.documentElement || parent === document.body) break;
          const clipping = getComputedStyle(parent);
          // Native scrolling deliberately reveals part of an item at a viewport boundary.
          if (/auto|scroll/.test(clipping.overflowX + clipping.overflowY)) break;
          if (!/hidden|clip/.test(clipping.overflowX + clipping.overflowY)) continue;
          const box = parent.getBoundingClientRect();
          if (
            lines.some(
              (line) =>
                (/hidden|clip/.test(clipping.overflowX) &&
                  (line.left < box.left - tolerance || line.right > box.right + tolerance)) ||
                (/hidden|clip/.test(clipping.overflowY) &&
                  (line.top < box.top - tolerance || line.bottom > box.bottom + tolerance)),
            )
          )
            add('clipped', element, parent);
        }
      }
      return findings;
    },
    [...allowances],
  );
}

async function captureLayoutAudit(
  page: Page,
  info: TestInfo,
  screen: string,
  scope: Page | Locator = page,
  options: { reportOnly?: boolean; allowances?: readonly LayoutAllowance[] } = {},
): Promise<LayoutFinding[]> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    let previous = '';
    let stable = 0;
    // Grid and panel observers can schedule another layout after the first animation frame.
    for (let frame = 0; frame < 30 && stable < 3; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const bounds = [...document.querySelectorAll('button, input, textarea, select, a[href]')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height].join(',');
        })
        .join('|');
      stable = bounds === previous ? stable + 1 : 0;
      previous = bounds;
    }
  });
  const findings = await auditTightSpaces(scope, options.allowances);
  const route = new URL(page.url());
  const theme = await page.locator('html').evaluate((root) => ({
    theme: root.dataset.theme,
    scheme: root.dataset.scheme,
  }));
  // Peer pages can reach the same state number while another report is still attaching.
  const stem = `layout-${screen.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 90)}-${createHash('sha256').update(screen).digest('hex').slice(0, 10)}-${++layoutReportSequence}`;
  await mkdir(info.outputDir, { recursive: true });
  const reportPath = info.outputPath(`${stem}.json`);
  await writeFile(
    reportPath,
    JSON.stringify(
      { screen, route: route.pathname + route.search, viewport: page.viewportSize(), ...theme, findings },
      null,
      2,
    ),
  );
  await info.attach(`layout-${screen}`, {
    path: reportPath,
    contentType: 'application/json',
  });
  if (findings.length || process.env.RIOSOMA_LAYOUT_SCREENSHOTS) {
    const screenshotPath = info.outputPath(`${stem}.png`);
    await page.screenshot({ path: screenshotPath });
    await info.attach(`layout-${screen}-screen`, { path: screenshotPath, contentType: 'image/png' });
  }
  if (!options.reportOnly) expect(findings, `Layout findings on ${screen}`).toEqual([]);
  return findings;
}

/** A failure includes selectors, a JSON report, and the screen as it was rendered. */
export async function recordLayoutAudit(
  page: Page,
  info: TestInfo,
  screen: string,
  scope: Page | Locator = page,
  options: { reportOnly?: boolean; allowances?: readonly LayoutAllowance[] } = {},
): Promise<LayoutFinding[]> {
  try {
    return await captureLayoutAudit(page, info, screen, scope, options);
  } catch (error) {
    if (!/Execution context was destroyed|Cannot find context with specified id/.test(String(error)))
      throw error;
    // Redirects can replace a document while its fonts or layout are settling.
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.readyState !== 'loading' && !!document.body);
    return captureLayoutAudit(page, info, screen, scope, options);
  }
}
