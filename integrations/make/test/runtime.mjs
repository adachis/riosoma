import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadApp } from '../deploy.mjs';
import { root } from '../app.mjs';
import { openapi } from '../../../apps/server/dist/api-v1/openapi.js';

export const document = openapi();
export const loaded = await loadApp();
export const { project, files } = loaded;
export const json = (path) => JSON.parse(files.get(path));
export const component = (kind, name, section) => json(project.components[kind][name].codeFiles[section]);
export const ids = {
  database: 'db00000000000001',
  table: 'tbl00000000000001',
  view: 'viw00000000000001',
  record: 'rec00000000000001',
  hook: 'whk00000000000001',
};
export const fieldId = (index) => `fld${String(index).padStart(14, '0')}`;
export const types = [
  'text',
  'number',
  'checkbox',
  'singleSelect',
  'longText',
  'attachment',
  'link',
  'user',
  'multipleSelect',
  'json',
  'dateRange',
  'location',
  'signature',
  'multiCurrency',
  'currency',
  'percent',
  'duration',
  'rating',
  'date',
  'url',
  'email',
  'phone',
  'barcode',
  'formula',
  'lookup',
  'rollup',
  'count',
  'autoNumber',
  'createdTime',
  'createdBy',
  'lastModifiedTime',
  'lastModifiedBy',
  'recordId',
  'button',
  'changeLog',
];
export const table = {
  id: ids.table,
  name: 'Records',
  fields: types.map((type, index) => ({
    id: fieldId(index),
    name: type,
    type,
    ...(type === 'singleSelect' ? { options: { choices: [{ id: 'choice', name: 'Ready' }] } } : {}),
  })),
  views: [{ id: ids.view, name: 'Selected' }],
};
export const record = {
  id: ids.record,
  createdTime: '2026-10-18T00:00:00.000Z',
  fields: { [fieldId(0)]: 'Example' },
};
export const payload = {
  id: 'delivery',
  webhookId: ids.hook,
  databaseId: ids.database,
  events: [
    { event: 'record.created', databaseId: ids.database, tableId: ids.table, recordId: ids.record, seq: 1 },
  ],
};
export function runtime() {
  const context = vm.createContext({ iml: {} });
  for (const [name, entry] of Object.entries(project.components.function)) {
    vm.runInContext(files.get(entry.codeFiles.code), context, { timeout: 1000 });
    context.iml[name] = context[name];
  }
  return context;
}
export function render(value, context) {
  if (typeof value === 'string') {
    const matches = [...value.matchAll(/\{\{([\s\S]*?)\}\}/g)];
    if (matches.length === 1 && matches[0][0] === value)
      return vm.runInNewContext(matches[0][1], context, { timeout: 1000 });
    return value.replace(/\{\{([\s\S]*?)\}\}/g, (_, code) =>
      String(vm.runInNewContext(code, context, { timeout: 1000 })),
    );
  }
  if (Array.isArray(value)) return value.map((entry) => render(entry, context));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === '{{...}}') Object.assign(result, render(entry, context));
    else {
      const rendered = render(entry, context);
      if (rendered !== undefined) result[key] = rendered;
    }
  }
  return result;
}
export const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// Walk the route's schema directly so recursive filter references remain recursive.
const schemaKeywords = new Set([
  '$schema',
  '$ref',
  '$defs',
  'title',
  'description',
  'default',
  'examples',
  'type',
  'properties',
  'propertyNames',
  'required',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'const',
  'enum',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'items',
  'minItems',
  'maxItems',
]);
export function validate(schema, value) {
  if (schema === true) return;
  assert.notEqual(schema, false);
  for (const key of Object.keys(schema))
    assert.ok(schemaKeywords.has(key), `Unsupported schema keyword: ${key}`);
  if (schema.$ref) {
    const target = schema.$ref
      .slice(2)
      .split('/')
      .reduce((entry, key) => entry[key.replaceAll('~1', '/').replaceAll('~0', '~')], document);
    assert.ok(target, schema.$ref);
    validate(target, value);
  }
  if (schema.anyOf || schema.oneOf) {
    const branches = schema.anyOf || schema.oneOf;
    const matches = branches.filter((branch) => {
      try {
        validate(branch, value);
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(schema.oneOf ? matches.length === 1 : matches.length > 0);
  }
  if (schema.allOf) for (const branch of schema.allOf) validate(branch, value);
  if (schema.not) assert.throws(() => validate(schema.not, value));
  if (schema.const !== undefined) assert.deepEqual(value, schema.const);
  if (schema.enum) assert.ok(schema.enum.includes(value));
  const typeMatches = (type) =>
    type === 'null'
      ? value === null
      : type === 'array'
        ? Array.isArray(value)
        : type === 'object'
          ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : type === 'integer'
            ? Number.isInteger(value)
            : typeof value === type;
  if (schema.type)
    assert.ok([schema.type].flat().some(typeMatches), `${JSON.stringify(value)} must be ${schema.type}`);
  if (typeof value === 'string') {
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern));
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength);
    if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength);
    if (schema.format === 'uri') assert.doesNotThrow(() => new URL(value));
  }
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value));
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems);
    if (schema.items) for (const entry of value) validate(schema.items, entry);
  } else if (value && typeof value === 'object') {
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), key);
    for (const [key, entry] of Object.entries(value)) {
      if (schema.propertyNames) validate(schema.propertyNames, key);
      if (schema.properties?.[key]) validate(schema.properties[key], entry);
      else if (schema.additionalProperties === false) assert.fail(key);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        validate(schema.additionalProperties, entry);
    }
  }
}
export function contract(request, scopes) {
  const url = new URL(request.url);
  const matching = Object.entries(document.paths).filter(([path]) => {
    const pattern = path.replace(/\{[^}]+\}/g, '([^/]+)');
    return new RegExp(`^${pattern}$`).test(url.pathname);
  });
  const [path, methods] =
    matching.sort(
      ([left], [right]) => (left.match(/\{/g)?.length || 0) - (right.match(/\{/g)?.length || 0),
    )[0] || [];
  assert.ok(path, url.pathname);
  const operation = methods[request.method.toLowerCase()];
  assert.ok(operation, `${request.method} ${path}`);
  if (scopes) assert.ok(scopes.includes(operation['x-required-scope']), operation['x-required-scope']);
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  const values = new RegExp(`^${path.replace(/\{[^}]+\}/g, '([^/]+)')}$`).exec(url.pathname).slice(1);
  const params = Object.fromEntries(names.map((name, index) => [name, values[index]]));
  for (const parameter of operation.parameters) {
    if (parameter.in === 'path') validate(parameter.schema, params[parameter.name]);
  }
  for (const [key, value] of Object.entries(request.qs || {})) {
    const parameter = operation.parameters.find((entry) => entry.in === 'query' && entry.name === key);
    assert.ok(parameter, key);
    validate(
      parameter.schema || parameter.content['application/json'].schema,
      parameter.content ? JSON.parse(value) : value,
    );
  }
  if (operation.requestBody) validate(operation.requestBody.content['application/json'].schema, request.body);
  else assert.equal(request.body, undefined);
  return operation;
}
export function runner(parameters = {}, extra = {}) {
  const functions = runtime();
  const context = {
    ...functions.iml,
    parameters: { ...ids, ...parameters },
    connection: { server: 'https://riosoma.example.invalid', token: 'unused' },
    temp: {},
    length: (value) => value?.length || 0,
    ...extra,
  };
  const calls = [];
  const base = json(project.generalCodeFiles.base);
  const execute = (specification, respond, scopes) => {
    let output;
    for (const step of [specification].flat()) {
      if (
        step.condition &&
        !render(typeof step.condition === 'object' ? step.condition.condition : step.condition, context)
      )
        continue;
      let request = {};
      do {
        const requestKeys = ['url', 'method', 'headers', 'qs', 'body', 'type'];
        const raw = Object.fromEntries(
          requestKeys.filter((key) => Object.hasOwn(step, key)).map((key) => [key, step[key]]),
        );
        request = {
          ...render(raw, context),
          ...(request.cursor === undefined ? {} : { qs: { ...request.qs, cursor: request.cursor } }),
        };
        request.method ||= 'GET';
        request.headers = { ...render(base.headers, context), ...request.headers };
        request.url = new URL(
          request.url.startsWith('https://') ? request.url : render(base.baseUrl, context) + request.url,
        ).href;
        calls.push(plain(request));
        contract(request, scopes);
        Object.assign(context, { body: undefined, statusCode: undefined });
        const response = respond(request, calls.length);
        Object.assign(context, {
          body: response.body,
          statusCode: response.status || 200,
          headers: response.headers || {},
        });
        const valid = step.response?.valid ?? base.response.valid;
        assert.ok(
          render(typeof valid === 'object' ? valid.condition : valid, context),
          'Response must be accepted',
        );
        if (step.response?.temp) Object.assign(context.temp, render(step.response.temp, context));
        if (step.response?.iterate) {
          output ||= [];
          for (const item of render(step.response.iterate, context)) {
            context.item = item;
            output.push(plain(render(step.response.output, context)));
            if (output.length >= (step.response.limit || Infinity)) break;
          }
        } else if (step.response?.output) output = plain(render(step.response.output, context));
        if (
          !step.pagination ||
          (output?.length || 0) >= (step.response?.limit || Infinity) ||
          !render(step.pagination.condition, context)
        )
          break;
        request.cursor = render(step.pagination.qs.cursor, context);
        if (calls.length > 50) assert.fail('Pagination must stop');
      } while (true);
    }
    return output;
  };
  return { context, calls, execute };
}
export const read = async (path) => readFile(new URL(path, root), 'utf8');
