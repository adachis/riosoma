import type { HelpRequest } from './help-request';
import type { ViewType } from '@riosoma/contracts';
import type { AnchorId } from '../demos/anchors';

export const viewHelp: Record<ViewType, HelpRequest & { anchorId: AnchorId }> = {
  grid: { id: 'views', section: 'hide-fields-and-row-height', anchorId: 'view.settings.grid' },
  kanban: { id: 'kanban', section: 'choosing-stacks-and-cards', anchorId: 'view.settings.kanban' },
  gallery: { id: 'gallery', section: 'setting-up-cards', anchorId: 'view.settings.gallery' },
  calendar: { id: 'calendar', section: 'choosing-dates', anchorId: 'view.settings.calendar' },
  timeline: { id: 'timeline-and-gantt', section: 'choosing-the-dates', anchorId: 'view.settings.timeline' },
  gantt: { id: 'timeline-and-gantt', section: 'a-gantt-chart-s-extras', anchorId: 'view.settings.gantt' },
  chart: { id: 'charts-and-pivot-tables', section: 'charts', anchorId: 'view.settings.chart' },
  pivot: { id: 'charts-and-pivot-tables', section: 'pivot-tables', anchorId: 'view.settings.pivot' },
  list: { id: 'list-and-map', section: 'shaping-a-list', anchorId: 'view.settings.list' },
  map: { id: 'list-and-map', section: 'placing-records-on-a-map', anchorId: 'view.settings.map' },
  form: { id: 'forms', section: 'designing-the-form', anchorId: 'view.settings.form' },
  orgChart: { id: 'views', section: 'org-chart', anchorId: 'view.settings.orgChart' },
};
