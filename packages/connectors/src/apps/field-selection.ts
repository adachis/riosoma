import { LIMITS, type RestEndpoint } from '@riosoma/contracts';
import { endpointUrl } from '../rest/connector.js';
import { isRecordObject, valueAt } from '../rest/records.js';
import { ConnectorError } from '../types.js';
import type { AppPreset } from './types.js';

/** Identifiers from metadata cannot introduce query syntax. */
export function fieldEndpoints(
  document: unknown,
  rule: NonNullable<AppPreset['fieldSelection']>,
  endpoint: RestEndpoint,
  address: string,
  object: string,
  key: string,
): RestEndpoint[] {
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const records = valueAt(document, rule.records);
  if (!Array.isArray(records) || !identifier.test(object) || !identifier.test(key))
    throw new ConnectorError('sources.app.discovery');
  const names = new Set([key]);
  for (const record of records) {
    const name = valueAt(record, rule.name);
    if (!isRecordObject(record) || typeof name !== 'string' || !identifier.test(name))
      throw new ConnectorError('sources.app.discovery');
    names.add(name);
  }
  const build = (fields: string[]): RestEndpoint => ({
    ...endpoint,
    query: [
      ...endpoint.query.filter((param) => param.name !== rule.param),
      {
        name: rule.param,
        value: rule.template.replaceAll('{fields}', fields.join(',')).replaceAll('{object}', object),
      },
    ],
  });
  const fits = (fields: string[]) => {
    const next = build(fields);
    return (
      fields.length <= (rule.maxFields ?? Infinity) &&
      next.query.every((param) => param.value.length <= 2_000) &&
      endpointUrl(address, next).href.length < Math.min(rule.maxUrlLength, LIMITS.urlLength)
    );
  };
  const endpoints: RestEndpoint[] = [];
  let group = [key];
  if (!fits(group)) throw new ConnectorError('sources.app.propertyTooLong');
  for (const name of [...names].slice(1)) {
    if (!fits([...group, name])) {
      endpoints.push(build(group));
      group = [key];
    }
    group.push(name);
    if (!fits(group)) throw new ConnectorError('sources.app.propertyTooLong');
  }
  endpoints.push(build(group));
  return endpoints;
}
