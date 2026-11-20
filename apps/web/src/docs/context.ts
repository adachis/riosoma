import type { DocModule } from './loader';
import type { ViewType } from '@riosoma/contracts';
import { viewHelp } from './view-help';

export interface HelpTopic {
  id: string;
  section?: string;
}

export interface HelpContext {
  route: string;
  anchors: string[];
  surface?: string[];
  focused?: string;
  viewType?: ViewType;
}

export function sectionId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function matchesRoute(pattern: string, route: string): boolean {
  const expected = pattern.split('/').filter(Boolean);
  const actual = route.split('/').filter(Boolean);
  return (
    expected.length <= actual.length &&
    expected.every((part, index) =>
      part.endsWith('*') ? Boolean(actual[index]?.startsWith(part.slice(0, -1))) : part === actual[index],
    )
  );
}

export function chooseContext(
  modules: readonly DocModule[],
  context: HelpContext,
): { best: HelpTopic | null; others: HelpTopic[] } {
  const viewTopic = context.viewType && context.viewType !== 'grid' ? viewHelp[context.viewType] : undefined;
  const matches = modules
    .flatMap(({ meta }) => {
      const focused = context.focused && meta.anchors.includes(context.focused) ? context.focused : undefined;
      const surface = context.surface?.find((id) => meta.anchors.includes(id));
      const routes = meta.routes.filter((pattern) => matchesRoute(pattern, context.route));
      const route = Math.max(
        0,
        ...routes.map((pattern) => pattern.split('/').filter((part) => part && part !== '*').length + 1),
      );
      const visible = context.anchors.filter((id) => meta.anchors.includes(id));
      const view = viewTopic?.id === meta.id ? viewTopic.anchorId : undefined;
      const score = focused ? 5 : surface ? 4 : view ? 3 : route ? 2 : visible.length ? 1 : 0;
      if (!score) return [];
      const anchor = focused ?? surface ?? view ?? visible[0];
      const section =
        meta.sections.find((entry) => entry.startsWith(`${anchor}=`))?.split('=')[1] ??
        meta.sections[0]?.split('=')[1];
      return [
        {
          topic: { id: meta.id, ...(section ? { section } : {}) },
          score,
          route,
          count: visible.length,
          order: meta.order,
        },
      ];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.route - a.route ||
        b.count - a.count ||
        a.order - b.order ||
        a.topic.id.localeCompare(b.topic.id),
    );
  return { best: matches[0]?.topic ?? null, others: matches.slice(1).map((match) => match.topic) };
}

export { collectContext } from './screen-context';
