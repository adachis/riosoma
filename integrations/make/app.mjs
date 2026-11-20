import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = new URL('./', import.meta.url);
export const messages = JSON.parse(await readFile(new URL('locales/en-US.json', root), 'utf8'));
export function message(key) {
  if (!Object.hasOwn(messages, key)) throw new Error(key);
  return messages[key];
}
const t = message;
const expression = (code) => `{{${code}}}`;
const segment = (key, record = false) => expression(`riosomaSegment(${key}, ${record})`);
const recordPath = `/tables/${segment('parameters.table')}/records`;
const tablesPath = `/databases/${segment('parameters.database')}/tables`;
const query = { shape: 'airtable', fieldKey: 'id' };
const schemaScope = 'schema.bases:read';
const readScope = 'data.records:read';
const writeScope = 'data.records:write';
const hookScope = 'schema.bases:write';

export async function definition() {
  const files = new Map();
  const put = (path, value) => {
    files.set(path, JSON.stringify(value, null, 2) + '\n');
    return path;
  };
  const project = {
    fileVersion: 1,
    generalCodeFiles: {},
    components: { connection: {}, function: {}, rpc: {}, webhook: {}, module: {}, endpoint: {} },
    origins: [],
  };
  const part = (type, name, metadata, sections) => {
    const codeFiles = {};
    for (const [key, value] of Object.entries(sections)) {
      codeFiles[key] = put(`${type}s/${name}/${key}.iml.json`, value);
    }
    project.components[type][name] = { ...metadata, codeFiles };
  };
  put('app.json', {
    name: 'riosoma',
    label: t('app.name'),
    description: t('app.description'),
    version: 1,
    language: 'en',
    theme: '#256b60',
    public: false,
    beta: true,
  });
  project.generalCodeFiles.base = put('base.iml.json', {
    baseUrl: expression("riosomaOrigin(connection.server) + '/api/v1'"),
    headers: { Authorization: 'Bearer {{connection.token}}', Accept: 'application/json' },
    followRedirects: false,
    followAllRedirects: false,
    response: {
      valid: '{{statusCode >= 200 && statusCode < 300}}',
      error: { message: t('error.request') },
    },
    log: {
      sanitize: ['request.headers.authorization', 'request.headers.Authorization', 'response.body.secret'],
    },
  });
  project.generalCodeFiles.common = put('common.iml.json', {});
  project.generalCodeFiles.groups = put('groups.iml.json', []);
  project.generalCodeFiles.readme = 'README.md';
  const runtimeMessages = Object.fromEntries(
    Object.entries(messages).filter(([key]) => key.startsWith('error.') || key.startsWith('field.')),
  );
  const runtimeCatalog = JSON.stringify(runtimeMessages).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  files.set(
    'functions/riosomaMessage.js',
    `function riosomaMessage(key) {\n  var messages = JSON.parse(\n    '${runtimeCatalog}',\n  );\n  return messages[key] || key;\n}\n`,
  );
  const functions = (await readdir(new URL('functions/', root))).filter((name) => name.endsWith('.js'));
  for (const filename of new Set([...functions, 'riosomaMessage.js'])) {
    project.components.function[filename.slice(0, -3)] = { codeFiles: { code: `functions/${filename}` } };
  }
  const connectionInputs = [
    {
      name: 'server',
      type: 'url',
      label: t('connection.address'),
      help: t('connection.addressHelp'),
      required: true,
      editable: true,
    },
    {
      name: 'token',
      type: 'password',
      label: t('connection.token'),
      help: t('connection.tokenHelp'),
      required: true,
      editable: true,
    },
  ];
  part(
    'connection',
    'riosoma',
    { label: t('app.name'), connectionType: 'basic' },
    {
      params: connectionInputs,
      communication: {
        url: expression("riosomaOrigin(parameters.server) + '/api/v1/databases'"),
        method: 'GET',
        headers: { Authorization: 'Bearer {{parameters.token}}', Accept: 'application/json' },
        followRedirects: false,
        followAllRedirects: false,
        response: {
          valid: '{{statusCode == 200}}',
          error: { message: t('error.request') },
          data: { server: '{{riosomaOrigin(parameters.server)}}', token: '{{parameters.token}}' },
          metadata: { type: 'text', value: '{{riosomaOrigin(parameters.server)}}' },
        },
        log: {
          sanitize: ['request.headers.authorization', 'request.headers.Authorization', 'response.body.token'],
        },
      },
    },
  );
  const select = (name, rpc) => ({
    name,
    type: 'select',
    label: t(`input.${name}`),
    required: true,
    options: `rpc://${rpc}`,
  });
  const selection = [select('database', 'databases'), select('table', 'tables')];
  const recordInput = { name: 'record', type: 'text', label: t('input.record'), required: true };
  const recordInterface = [
    { name: 'id', type: 'text', label: t('output.id') },
    { name: 'createdTime', type: 'text', label: t('output.created') },
    { name: 'fields', type: 'collection', label: t('output.fields'), spec: [] },
  ];
  // Shared files keep Make's native layout while avoiding repeated interfaces and empty sections.
  const empty = put('shared/empty.iml.json', []);
  const recordOutput = put('shared/record-interface.iml.json', recordInterface);
  const sample = put('shared/record-sample.iml.json', { id: 'rec00000000000001', fields: {} });
  const rpc = (name, communication) =>
    part('rpc', name, { label: t(`rpc.${name}`), connection: 'riosoma' }, { communication, params: [] });
  rpc('databases', {
    url: '/databases',
    method: 'GET',
    response: { iterate: '{{body.databases}}', output: { label: '{{item.name}}', value: '{{item.id}}' } },
  });
  rpc('tables', {
    url: tablesPath,
    method: 'GET',
    response: { iterate: '{{body.tables}}', output: { label: '{{item.name}}', value: '{{item.id}}' } },
  });
  rpc('views', {
    url: tablesPath,
    method: 'GET',
    response: {
      iterate: '{{riosomaTable(body.tables, parameters.table).views}}',
      output: { label: '{{item.name}}', value: '{{item.id}}' },
    },
  });
  for (const [name, search] of [
    ['fields', false],
    ['searchFields', true],
  ]) {
    rpc(name, {
      url: tablesPath,
      method: 'GET',
      response: {
        iterate: expression(`riosomaFields(riosomaTable(body.tables, parameters.table), ${search})`),
        output: '{{item}}',
      },
    });
  }
  const nestedSelection = (inputs) => {
    if (inputs[0]?.name !== 'database') return inputs;
    const [database, table, ...rest] = inputs;
    return [
      {
        ...database,
        mappable: false,
        options: {
          store: database.options,
          nested: [{ ...table, mappable: false, options: { store: table.options, nested: rest } }],
        },
      },
    ];
  };
  const module = (name, label, type, communication, inputs, scopes) => {
    part(
      'module',
      name,
      {
        label: t(`module.${label}`),
        description: t(`module.${label}Description`),
        moduleType: type,
        connection: 'riosoma',
      },
      {
        communication,
        mappableParams: nestedSelection(inputs),
        scope: scopes,
      },
    );
    Object.assign(project.components.module[name].codeFiles, {
      staticParams: empty,
      interface: recordOutput,
      samples: sample,
    });
  };
  const schemaRead = {
    url: tablesPath,
    method: 'GET',
    response: { temp: { table: '{{riosomaTable(body.tables, parameters.table)}}' } },
  };
  for (const [name, update] of [
    ['createRecord', false],
    ['updateRecord', true],
  ]) {
    module(
      name,
      update ? 'update' : 'create',
      'action',
      [
        schemaRead,
        {
          url: recordPath,
          method: update ? 'PATCH' : 'POST',
          qs: query,
          body: expression(`riosomaWrite(parameters, temp.table, ${update})`),
          response: { output: '{{riosomaRecord(body)}}' },
        },
      ],
      [
        ...selection,
        ...(update ? [recordInput] : []),
        { name: 'fields', type: 'collection', label: t('input.fields'), spec: 'rpc://fields' },
      ],
      [schemaScope, writeScope],
    );
  }
  module(
    'getRecord',
    'get',
    'action',
    {
      url: `${recordPath}/${segment('parameters.record', true)}`,
      method: 'GET',
      qs: query,
      response: {
        valid: {
          condition: '{{statusCode == 200 && length(body.records) == 1}}',
          message: t('error.missing'),
        },
        output: '{{riosomaRecord(body)}}',
      },
    },
    [...selection, recordInput],
    [schemaScope, readScope],
  );
  module(
    'searchRecords',
    'search',
    'search',
    [
      schemaRead,
      {
        url: recordPath,
        method: 'GET',
        qs: {
          ...query,
          pageSize: 100,
          filter: '{{riosomaFilter(temp.table, parameters.searchField, parameters.searchValue)}}',
        },
        response: {
          temp: { seen: '{{riosomaCursor(body.offset, temp.seen)}}' },
          iterate: '{{body.records}}',
          limit: 1000,
          output: '{{item}}',
        },
        pagination: { qs: { cursor: '{{body.offset}}' }, condition: '{{body.offset}}' },
      },
    ],
    [
      ...selection,
      {
        name: 'searchField',
        type: 'select',
        label: t('input.searchField'),
        required: true,
        options: 'rpc://searchFields',
      },
      { name: 'searchValue', type: 'any', label: t('input.searchValue'), required: true },
    ],
    [schemaScope, readScope],
  );
  module(
    'apiCall',
    'api',
    'universal',
    {
      url: "{{riosomaOrigin(connection.server)}}{{riosomaApi('path', parameters.path)}}",
      method: "{{riosomaApi('method', parameters.method)}}",
      qs: { '{{...}}': "{{riosomaApi('query', parameters.query)}}" },
      body: "{{riosomaApi('json', parameters.body)}}",
      response: { output: { body: '{{body}}', headers: '{{headers}}', statusCode: '{{statusCode}}' } },
    },
    [
      { name: 'path', type: 'text', label: t('input.path'), help: t('input.pathHelp'), required: true },
      {
        name: 'method',
        type: 'select',
        label: t('input.method'),
        required: true,
        default: 'GET',
        options: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].map((value) => ({
          label: t(`method.${value}`),
          value,
        })),
      },
      {
        name: 'query',
        type: 'array',
        label: t('input.query'),
        spec: [
          { name: 'key', type: 'text', label: t('input.key'), required: true },
          { name: 'value', type: 'text', label: t('input.value') },
        ],
      },
      { name: 'body', type: 'text', label: t('input.body'), help: t('input.bodyHelp'), multiline: true },
    ],
    [],
  );
  project.components.module.apiCall.codeFiles.interface = put('shared/api-interface.iml.json', [
    { name: 'body', type: 'any', label: t('output.body') },
    { name: 'headers', type: 'collection', label: t('output.headers'), spec: [] },
    { name: 'statusCode', type: 'number', label: t('output.status') },
  ]);
  for (const [name, label, event, view] of [
    ['watchNewRecords', 'created', 'record.created', false],
    ['watchUpdatedRecords', 'updated', 'record.updated', false],
    ['watchNewRecordsInView', 'view', 'record.created', true],
  ]) {
    const inputs = [...selection, ...(view ? [select('view', 'views')] : [])];
    part(
      'webhook',
      name,
      { label: t(`module.${label}`), webhookType: 'web', connection: 'riosoma' },
      {
        params: nestedSelection(inputs),
        communication: {
          iterate: { container: expression(`riosomaEvents(body, parameters, '${event}')`) },
          output: '{{item}}',
          respond: { status: 200 },
        },
        attach: {
          url: `/databases/${segment('parameters.database')}/webhooks`,
          method: 'POST',
          body: { url: '{{webhook.url}}', events: [event], tableIds: [segment('parameters.table')] },
          response: {
            data: {
              hookId: '{{body.id}}',
              database: '{{parameters.database}}',
              table: '{{parameters.table}}',
              ...(view ? { view: '{{parameters.view}}' } : {}),
            },
          },
        },
        detach: {
          url: `/databases/${segment('webhook.database')}/webhooks/${segment('webhook.hookId')}`,
          method: 'DELETE',
          response: { valid: '{{statusCode == 204 || statusCode == 404}}' },
        },
        requiredScope: [schemaScope, hookScope, readScope],
      },
    );
    module(
      name,
      label,
      'instant_trigger',
      {
        url: `/tables/${segment('payload.table')}/records/${segment('payload.recordId')}`,
        method: 'GET',
        qs: { ...query, ...(view ? { view: '{{payload.view}}' } : {}) },
        response: {
          valid: '{{statusCode == 200 || statusCode == 404}}',
          output: '{{riosomaRecord(body, payload)}}',
        },
      },
      [],
      [schemaScope, hookScope, readScope],
    );
    project.components.module[name].webhook = name;
    project.components.module[name].codeFiles.interface = put(`modules/${name}/interface.iml.json`, [
      { name: 'id', type: 'text', label: t('output.event') },
      { name: 'recordId', type: 'text', label: t('output.id') },
      ...recordInterface.slice(1),
    ]);
    project.components.module[name].codeFiles.samples = put(`modules/${name}/samples.iml.json`, {
      id: event === 'record.updated' ? 'rec00000000000001:1' : 'rec00000000000001',
      recordId: 'rec00000000000001',
      fields: {},
    });
  }
  put('makecomapp.json', project);
  return files;
}

export async function build() {
  for (const [path, content] of await definition()) {
    const url = new URL(path, root);
    await mkdir(dirname(fileURLToPath(url)), { recursive: true });
    await writeFile(url, content);
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await build();
