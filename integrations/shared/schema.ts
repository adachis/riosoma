import { IntegrationError } from '../../packages/ui/src/integrations/messages';

export interface Field {
  id: string;
  name: string;
  type: string;
  options?: { choices?: { id: string; name: string }[] };
  permissions?: { edit?: string };
}
export interface Table {
  id: string;
  name: string;
  fields: Field[];
  views: { id: string; name: string }[];
}
export interface RecordData {
  id: string;
  createdTime?: string;
  fields: Record<string, unknown>;
}
export interface RecordsPage {
  records: RecordData[];
  offset?: string;
}

const computed = new Set([
  'changeLog',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'recordId',
  'lookup',
  'rollup',
  'count',
  'formula',
  'autoNumber',
  'button',
]);
export const writable = (field: Field) => !computed.has(field.type);
export const textTypes = new Set(['text', 'longText', 'url', 'email', 'phone', 'barcode']);
export const numberTypes = new Set(['number', 'currency', 'percent', 'duration', 'rating']);
export const structuredTypes = new Set([
  'attachment',
  'link',
  'user',
  'multipleSelect',
  'json',
  'dateRange',
  'location',
  'signature',
  'multiCurrency',
]);

export function segment(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new IntegrationError('integration.invalid');
  return encodeURIComponent(value);
}

/** Plain HTTP is only for a server on this computer, reached by its loopback IP. */
export const loopbackHosts = ['127.0.0.1', '[::1]'];

export function secureOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IntegrationError('integration.secureOrigin');
  }
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHosts.includes(url.hostname))) ||
    url.username ||
    url.password ||
    // Only a plain host name or an IP literal, so a wildcard can never widen a host permission.
    !/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)$/i.test(url.hostname) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new IntegrationError('integration.secureOrigin');
  }
  return url.origin;
}

export function exactFilter(field: Field, value: unknown) {
  let op = 'is';
  if (numberTypes.has(field.type)) {
    if (typeof value === 'string' && value.trim()) value = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new IntegrationError('integration.invalid');
    op = 'eq';
  } else if (field.type === 'checkbox') {
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    if (typeof value !== 'boolean') throw new IntegrationError('integration.invalid');
  } else if (textTypes.has(field.type)) {
    if (typeof value !== 'string' || !value.length) throw new IntegrationError('integration.invalid');
  } else {
    throw new IntegrationError('integration.invalid');
  }
  return { conjunction: 'and', conditions: [{ id: 'match', fieldId: field.id, operator: op, value }] };
}
