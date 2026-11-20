import type { HelpContext } from './context';
import type { ViewType } from '@riosoma/contracts';
import { viewHelp } from './view-help';

/** Capture before menus close or focus moves into help. */
export function collectContext(
  document: Document,
  route: string,
  active: Element | null = document.activeElement,
): HelpContext {
  const visible = (element: Element) => {
    if (element.closest('[hidden], [aria-hidden="true"], [inert], [data-help-content], .rio-palette'))
      return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const focused = active?.closest('[data-anchor]')?.getAttribute('data-anchor') ?? undefined;
  const surfaces = [...document.querySelectorAll('[role="dialog"], [data-help-surface]')].filter(visible);
  const surface = surfaces.findLast((element) => element.contains(active)) ?? surfaces.at(-1);
  const anchors = [...document.querySelectorAll<HTMLElement>('[data-anchor]')].filter(
    (element) => visible(element) && (element.closest('main') || surface?.contains(element)),
  );
  const view = [...document.querySelectorAll<HTMLElement>('main [data-help-view]')].find(visible)?.dataset
    .helpView;
  const viewType =
    view && Object.hasOwn(viewHelp, view)
      ? (view as ViewType)
      : (Object.keys(viewHelp) as ViewType[]).find(
          (type) =>
            type !== 'grid' && anchors.some((element) => element.dataset.anchor === viewHelp[type].anchorId),
        );
  return {
    route,
    anchors: [...new Set(anchors.map((element) => element.dataset.anchor!))],
    ...(viewType ? { viewType } : {}),
    ...(focused && active && visible(active) ? { focused } : {}),
    surface: anchors
      .filter((element) => surface?.contains(element))
      .map((element) => element.dataset.anchor!),
  };
}
