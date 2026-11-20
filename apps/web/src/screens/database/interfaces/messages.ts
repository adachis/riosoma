import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { BlockBand, BlockKind, FilterControl, RecordsDisplay, TextStyle } from '@riosoma/contracts';

export const KIND_LABELS: Record<BlockKind, MessageDescriptor> = {
  hero: msg({ id: 'interfaces.block.hero', message: 'Hero' }),
  media: msg({ id: 'interfaces.block.media', message: 'Image or video' }),
  code: msg({ id: 'interfaces.block.code', message: 'Custom code' }),
  records: msg({ id: 'interfaces.block.records', message: 'Records' }),
  record: msg({ id: 'interfaces.block.record', message: 'Record details' }),
  number: msg({ id: 'interfaces.block.number', message: 'Number' }),
  chart: msg({ id: 'interfaces.block.chart', message: 'Chart' }),
  text: msg({ id: 'interfaces.block.text', message: 'Text' }),
  filter: msg({ id: 'interfaces.block.filter', message: 'Filter' }),
  button: msg({ id: 'interfaces.block.button', message: 'Button' }),
};

/** What each kind of block is for, under its name in the editor */
export const KIND_DESCRIPTIONS: Record<BlockKind, MessageDescriptor> = {
  hero: msg({
    id: 'interfaces.block.hero.about',
    message: 'A page opening with a heading, lead, buttons, and an image',
  }),
  media: msg({ id: 'interfaces.block.media.about', message: 'An image or video attached to a record' }),
  code: msg({ id: 'interfaces.block.code.about', message: 'HTML, CSS, and JavaScript in an isolated frame' }),
  records: msg({
    id: 'interfaces.block.records.about',
    message: 'A list, table, or card grid of records from a view',
  }),
  record: msg({
    id: 'interfaces.block.record.about',
    message: 'The fields of the record picked in a records block',
  }),
  number: msg({ id: 'interfaces.block.number.about', message: 'A count, sum, or other value' }),
  chart: msg({ id: 'interfaces.block.chart.about', message: 'Records grouped and compared' }),
  text: msg({ id: 'interfaces.block.text.about', message: 'A heading or a paragraph' }),
  filter: msg({
    id: 'interfaces.block.filter.about',
    message: 'A choice or search box that narrows records',
  }),
  button: msg({ id: 'interfaces.block.button.about', message: 'Opens a form or a web page' }),
};

export const DISPLAY_LABELS: Record<RecordsDisplay, MessageDescriptor> = {
  accordion: msg({ id: 'interfaces.records.accordion', message: 'Accordion' }),
  sections: msg({ id: 'interfaces.records.sections', message: 'Sections' }),
  cards: msg({ id: 'interfaces.records.cards', message: 'Cards' }),
  list: msg({ id: 'interfaces.records.list', message: 'List' }),
  table: msg({ id: 'interfaces.records.table', message: 'Table' }),
};

export const STYLE_LABELS: Record<TextStyle, MessageDescriptor> = {
  lead: msg({ id: 'interfaces.text.lead', message: 'Lead paragraph' }),
  heading: msg({ id: 'interfaces.text.heading', message: 'Heading' }),
  paragraph: msg({ id: 'interfaces.text.paragraph', message: 'Paragraph' }),
};

export const CONTROL_LABELS: Record<FilterControl, MessageDescriptor> = {
  choice: msg({ id: 'interfaces.filter.choice', message: 'Choice' }),
  search: msg({ id: 'interfaces.filter.search', message: 'Search box' }),
};

export const BAND_LABELS: Record<BlockBand, MessageDescriptor> = {
  none: msg({ id: 'interfaces.band.none', message: 'None' }),
  quiet: msg({ id: 'interfaces.band.quiet', message: 'Quiet' }),
  accent: msg({ id: 'interfaces.band.accent', message: 'Accent' }),
  inverse: msg({ id: 'interfaces.band.inverse', message: 'Inverse' }),
};
