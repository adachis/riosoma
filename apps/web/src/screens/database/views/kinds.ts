import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  faBarsStaggered,
  faCalendarDays,
  faChartGantt,
  faChartSimple,
  faListUl,
  faSitemap,
  faMapLocationDot,
  faRectangleList,
  faTableCells,
  faTableCellsLarge,
  faTableColumns,
  faTableList,
} from '@fortawesome/free-solid-svg-icons';
import type { ViewType } from '@riosoma/contracts';
import type { IconDefinition } from '@riosoma/icons';

/**
 * Each kind of view's icon and name, apart from how it draws, so menus and the palette can name a
 * kind without loading everything the view needs.
 */
export const VIEW_KINDS: Record<ViewType, { icon: IconDefinition; name: MessageDescriptor }> = {
  grid: { icon: faTableCells, name: msg({ id: 'view.type.grid', message: 'Grid' }) },
  kanban: { icon: faTableColumns, name: msg({ id: 'view.type.kanban', message: 'Kanban' }) },
  gallery: { icon: faTableCellsLarge, name: msg({ id: 'view.type.gallery', message: 'Gallery' }) },
  calendar: { icon: faCalendarDays, name: msg({ id: 'view.type.calendar', message: 'Calendar' }) },
  timeline: { icon: faBarsStaggered, name: msg({ id: 'views.timeline.name', message: 'Timeline' }) },
  gantt: { icon: faChartGantt, name: msg({ id: 'views.gantt.name', message: 'Gantt' }) },
  form: { icon: faRectangleList, name: msg({ id: 'view.type.form', message: 'Form' }) },
  chart: { icon: faChartSimple, name: msg({ id: 'views.chart.name', message: 'Chart' }) },
  pivot: { icon: faTableList, name: msg({ id: 'views.pivot.name', message: 'Pivot table' }) },
  orgChart: { icon: faSitemap, name: msg({ id: 'views.orgChart.name', message: 'Org chart' }) },
  list: { icon: faListUl, name: msg({ id: 'views.list.name', message: 'List' }) },
  map: { icon: faMapLocationDot, name: msg({ id: 'views.map.name', message: 'Map' }) },
};
