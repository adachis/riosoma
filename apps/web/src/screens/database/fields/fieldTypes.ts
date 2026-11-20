import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { IconDefinition } from '@riosoma/icons';
import {
  faAlignLeft,
  faArrowRightArrowLeft,
  faArrowUp19,
  faAt,
  faCalendar,
  faCalendarWeek,
  faCircleChevronDown,
  faCircleUser,
  faClock,
  faClockRotateLeft,
  faCode,
  faCoins,
  faFileCode,
  faFingerprint,
  faFont,
  faHandPointer,
  faHashtag,
  faLink,
  faList,
  faListOl,
  faLocationDot,
  faMagnifyingGlassArrowRight,
  faPaperclip,
  faPercent,
  faPhone,
  faSignature,
  faSquareCheck,
  faSquareRootVariable,
  faStar,
  faStopwatch,
  faUser,
  faUserPen,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import type { FieldMeta, FieldType } from '@riosoma/contracts';
import { AI_FIELD_DESCRIPTION, AI_FIELD_NAME } from '../../../features/ai-fields/messages';

/** Each field type's icon and name, and for some a line on what it holds, in the order menus list them. */
export const FIELD_TYPE_INFO: ReadonlyArray<{
  type: FieldType;
  icon: IconDefinition;
  name: MessageDescriptor;
  description?: MessageDescriptor;
}> = [
  { type: 'barcode', icon: faHashtag, name: msg({ id: 'field.type.barcode', message: 'Barcode' }) },
  { type: 'time', icon: faClock, name: msg({ id: 'field.type.time', message: 'Time of day' }) },
  {
    type: 'multiCurrency',
    icon: faCoins,
    name: msg({ id: 'field.type.multiCurrency', message: 'Multi-currency' }),
  },
  {
    type: 'changeLog',
    icon: faClockRotateLeft,
    name: msg({ id: 'field.type.changeLog', message: 'Change log' }),
  },
  {
    type: 'lineItems',
    icon: faListOl,
    name: msg({ id: 'field.type.lineItems', message: 'Line items' }),
    description: msg({
      id: 'lineItems.description',
      message: 'An ordered table of rows inside this record.',
    }),
  },
  { type: 'text', icon: faFont, name: msg({ id: 'field.type.text', message: 'Text' }) },
  { type: 'longText', icon: faAlignLeft, name: msg({ id: 'field.type.longText', message: 'Long text' }) },
  {
    type: 'attachment',
    icon: faPaperclip,
    name: msg({ id: 'field.type.attachment', message: 'Attachment' }),
  },
  { type: 'number', icon: faHashtag, name: msg({ id: 'field.type.number', message: 'Number' }) },
  { type: 'currency', icon: faCoins, name: msg({ id: 'field.type.currency', message: 'Currency' }) },
  { type: 'percent', icon: faPercent, name: msg({ id: 'field.type.percent', message: 'Percent' }) },
  { type: 'duration', icon: faStopwatch, name: msg({ id: 'field.type.duration', message: 'Duration' }) },
  { type: 'checkbox', icon: faSquareCheck, name: msg({ id: 'field.type.checkbox', message: 'Checkbox' }) },
  { type: 'rating', icon: faStar, name: msg({ id: 'field.type.rating', message: 'Rating' }) },
  { type: 'date', icon: faCalendar, name: msg({ id: 'field.type.date', message: 'Date' }) },
  {
    type: 'dateRange',
    icon: faCalendarWeek,
    name: msg({ id: 'fields.dateRange.name', message: 'Date range' }),
    description: msg({ id: 'fields.dateRange.description', message: 'A start and an end date.' }),
  },
  {
    type: 'singleSelect',
    icon: faCircleChevronDown,
    name: msg({ id: 'field.type.singleSelect', message: 'Single select' }),
  },
  {
    type: 'multipleSelect',
    icon: faList,
    name: msg({ id: 'field.type.multipleSelect', message: 'Multiple select' }),
  },
  { type: 'user', icon: faCircleUser, name: msg({ id: 'field.type.user', message: 'User' }) },
  { type: 'email', icon: faAt, name: msg({ id: 'field.type.email', message: 'Email' }) },
  { type: 'url', icon: faLink, name: msg({ id: 'field.type.url', message: 'URL' }) },
  { type: 'phone', icon: faPhone, name: msg({ id: 'field.type.phone', message: 'Phone number' }) },
  {
    type: 'location',
    icon: faLocationDot,
    name: msg({ id: 'fields.location.name', message: 'Location' }),
    description: msg({
      id: 'fields.location.description',
      message: 'A place, as coordinates with an optional address.',
    }),
  },
  {
    type: 'json',
    icon: faFileCode,
    name: msg({ id: 'fields.json.name', message: 'JSON' }),
    description: msg({ id: 'fields.json.description', message: 'Structured data, checked on save.' }),
  },
  {
    type: 'signature',
    icon: faSignature,
    name: msg({ id: 'fields.signature.name', message: 'Signature' }),
    description: msg({ id: 'fields.signature.description', message: 'A drawn or typed signature.' }),
  },
  {
    type: 'button',
    icon: faHandPointer,
    name: msg({ id: 'fields.button.name', message: 'Button' }),
    description: msg({
      id: 'fields.button.description',
      message: 'Opens a link made from the record’s fields.',
    }),
  },
  {
    type: 'createdTime',
    icon: faClock,
    name: msg({ id: 'field.type.createdTime', message: 'Created time' }),
  },
  {
    type: 'lastModifiedTime',
    icon: faClockRotateLeft,
    name: msg({ id: 'field.type.lastModifiedTime', message: 'Last modified time' }),
  },
  { type: 'createdBy', icon: faUser, name: msg({ id: 'field.type.createdBy', message: 'Created by' }) },
  {
    type: 'lastModifiedBy',
    icon: faUserPen,
    name: msg({ id: 'field.type.lastModifiedBy', message: 'Last modified by' }),
  },
  { type: 'recordId', icon: faFingerprint, name: msg({ id: 'field.type.recordId', message: 'Record ID' }) },
  {
    type: 'autoNumber',
    icon: faArrowUp19,
    name: msg({ id: 'field.type.autoNumber', message: 'Autonumber' }),
  },
  {
    type: 'link',
    icon: faArrowRightArrowLeft,
    name: msg({ id: 'field.type.link', message: 'Link to another record' }),
  },
  {
    type: 'lookup',
    icon: faMagnifyingGlassArrowRight,
    name: msg({ id: 'field.type.lookup', message: 'Lookup' }),
  },
  { type: 'rollup', icon: faSquareRootVariable, name: msg({ id: 'field.type.rollup', message: 'Rollup' }) },
  { type: 'count', icon: faListOl, name: msg({ id: 'field.type.count', message: 'Count' }) },
  { type: 'formula', icon: faCode, name: msg({ id: 'field.type.formula', message: 'Formula' }) },
];

/** The AI field, which the type menu offers after the stored types and which keeps one of them. */
export const AI_FIELD_INFO = {
  type: 'ai' as const,
  icon: faWandMagicSparkles,
  name: AI_FIELD_NAME,
  description: AI_FIELD_DESCRIPTION,
};

const BY_TYPE = new Map(FIELD_TYPE_INFO.map((info) => [info.type, info]));

export function fieldTypeInfo(type: FieldType) {
  return BY_TYPE.get(type) ?? FIELD_TYPE_INFO[0]!;
}

/** A field's icon and name as headers show them: an AI field's own, or its type's. */
export function fieldInfo(field: Pick<FieldMeta, 'type' | 'ai'>) {
  return field.ai ? AI_FIELD_INFO : fieldTypeInfo(field.type);
}
