import { newId } from '@riosoma/contracts';
import { randomUUID } from 'node:crypto';

export interface TenantResource {
  databaseId: string;
  tableId: string;
  joinedTableId: string;
  joinedFieldId: string;
  viewId: string;
  fieldId: string;
  attachmentFieldId: string;
  recordId: string;
  dashboardId: string;
  interfaceId: string;
  automationId: string;
  functionId: string;
  libraryId: string;
  attachmentId: string;
  webhookId: string;
  deliveryId: string;
  jobId: string;
}

/** Valid requests vary only by resource IDs, so validation cannot mask a missing access check. */
export function tenantRoutes(r: TenantResource) {
  const table = `/api/tables/${r.tableId}`;
  const view = `/api/views/${r.viewId}`;
  const rest = `/api/v1/tables/${r.tableId}/records`;
  const functions = `/api/v1/databases/${r.databaseId}/named-functions`;
  const definition = { name: 'CHANGED_FUNCTION', parameters: [], body: '2', description: '' };
  const home = {
    id: newId('command'),
    action: {
      kind: 'shortcut.create',
      shortcutId: newId('shortcut'),
      target: { kind: 'view', id: r.viewId },
    },
  };
  const library = {
    kind: 'library.save',
    id: randomUUID(),
    libraryId: r.libraryId,
    scope: { kind: 'database', databaseId: r.databaseId },
    details: { name: 'changed', description: '', label: 'public' },
  };
  return [
    { method: 'POST', url: `${rest}/duplicate`, token: true, payload: { recordIds: [r.recordId] } },
    {
      method: 'POST',
      url: `/api/v1/fields/${r.fieldId}/duplicate`,
      token: true,
      payload: { name: 'Field copy', withValues: true },
    },
    {
      method: 'POST',
      url: `/api/v1/tables/${r.tableId}/duplicate`,
      token: true,
      payload: { name: 'Table copy', withRecords: true },
    },
    ...['/api', '/api/v1'].flatMap((prefix) => [
      { method: 'GET' as const, url: `${prefix}/duplicate-jobs/${r.jobId}`, token: prefix.includes('/v1') },
      {
        method: 'POST' as const,
        url: `${prefix}/duplicate-jobs/${r.jobId}/cancel`,
        token: prefix.includes('/v1'),
      },
    ]),
    { method: 'GET', url: functions, token: true },
    { method: 'POST', url: functions, token: true, payload: definition },
    {
      method: 'PATCH',
      url: `${functions}/${r.functionId}`,
      token: true,
      payload: { definition, revision: 1 },
    },
    {
      method: 'DELETE',
      url: `${functions}/${r.functionId}`,
      token: true,
      payload: { revision: 1, confirmUsed: true },
    },
    ...['/api', '/api/v1'].flatMap((prefix) => {
      const url = `${prefix}/databases/${r.databaseId}/webhooks`;
      const token = prefix.includes('/v1');
      return [
        { method: 'GET' as const, url, token },
        {
          method: 'POST' as const,
          url,
          token,
          payload: {
            url: 'https://receiver.example.test/',
            events: ['record.created'],
            tableIds: [r.tableId],
            enabled: false,
          },
        },
        { method: 'PATCH' as const, url: `${url}/${r.webhookId}`, token, payload: { enabled: true } },
        { method: 'DELETE' as const, url: `${url}/${r.webhookId}`, token },
        { method: 'POST' as const, url: `${url}/${r.webhookId}/secret`, token },
        { method: 'GET' as const, url: `${url}/${r.webhookId}/deliveries`, token },
        { method: 'POST' as const, url: `${url}/${r.webhookId}/deliveries/${r.deliveryId}/redeliver`, token },
      ];
    }),
    { method: 'GET', url: '/api/databases', collection: true },
    { method: 'GET', url: '/api/home', collection: true },
    { method: 'GET', url: '/api/v1/databases', token: true, collection: true },
    { method: 'GET', url: '/api/v1/home', token: true, collection: true },
    { method: 'POST', url: '/api/v1/home/commands', token: true, payload: home },
    { method: 'GET', url: '/api/files?ids=' + r.attachmentId, collection: true },
    { method: 'GET', url: `/api/files/${r.attachmentId}/note.png` },
    { method: 'GET', url: `/api/files/${r.attachmentId}/thumbnails/small` },
    { method: 'GET', url: `/api/tables/${r.tableId}/permissions` },
    {
      method: 'PUT',
      url: `/api/fields/${r.fieldId}/permissions`,
      payload: { restricted: null, locked: null },
    },
    { method: 'PUT', url: `/api/tables/${r.tableId}/record-rules`, payload: { rules: [] } },
    ...(['GET', 'DELETE', 'PUT'] as const).map((method) => ({
      method,
      url: `/api/interfaces/${r.interfaceId}/site`,
      ...(method === 'PUT'
        ? {
            payload: {
              slug: 'tenant-corpus',
              title: 'changed',
              pages: [{ pageId: 'page01', slug: 'notes', title: 'changed' }],
              theme: { id: 'palette', scheme: 'house' },
            },
          }
        : {}),
    })),
    ...['/api', '/api/v1'].flatMap((prefix) => [
      {
        method: 'POST' as const,
        url: `${prefix}/tables/${r.tableId}/fields/${r.attachmentFieldId}/files`,
        token: prefix.includes('/v1'),
        headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'note.txt' },
        payload: 'changed',
      },
      {
        method: 'GET' as const,
        url: `${prefix}/knowledge/libraries`,
        token: prefix.includes('/v1'),
        collection: true,
      },
      {
        method: 'GET' as const,
        url: `${prefix}/knowledge/libraries/${r.libraryId}/documents`,
        token: prefix.includes('/v1'),
      },
      {
        method: 'POST' as const,
        url: `${prefix}/knowledge/search-documents`,
        token: prefix.includes('/v1'),
        payload: { query: 'TENANT_SENTINEL', libraryId: r.libraryId },
      },
      {
        method: 'POST' as const,
        url: `${prefix}/knowledge/library-commands`,
        token: prefix.includes('/v1'),
        rejected: true,
        payload: library,
      },
    ]),
    { method: 'PATCH', url: `/api/v1/views/${r.viewId}/grid`, token: true, payload: {} },
    { method: 'GET', url: `/api/v1/databases/${r.databaseId}/memories`, token: true },
    {
      method: 'POST',
      url: '/api/v1/knowledge/memories',
      token: true,
      rejected: true,
      payload: { databaseId: r.databaseId, memoryId: randomUUID(), text: 'changed' },
    },
    {
      method: 'POST',
      url: '/api/v1/knowledge/similar',
      token: true,
      payload: { tableId: r.tableId, text: 'TENANT_SENTINEL' },
    },
    {
      method: 'POST',
      url: `/api/v1/databases/${r.databaseId}/tables`,
      token: true,
      payload: { name: 'changed', fields: [{ name: 'Text', type: 'text' }] },
    },
    { method: 'PATCH', url: `/api/v1/tables/${r.tableId}`, token: true, payload: { name: 'changed' } },
    { method: 'DELETE', url: `/api/v1/tables/${r.tableId}`, token: true },
    {
      method: 'POST',
      url: `/api/v1/tables/${r.tableId}/fields`,
      token: true,
      payload: { name: 'changed', type: 'text' },
    },
    { method: 'PATCH', url: `/api/v1/fields/${r.fieldId}`, token: true, payload: { name: 'changed' } },
    { method: 'DELETE', url: `/api/v1/fields/${r.fieldId}`, token: true },
    { method: 'POST', url: `/api/v1/tables/${r.tableId}/views`, token: true, payload: { name: 'changed' } },
    { method: 'PATCH', url: `/api/v1/views/${r.viewId}`, token: true, payload: { name: 'changed' } },
    { method: 'DELETE', url: `/api/v1/views/${r.viewId}`, token: true },
    { method: 'GET', url: `/api/v1/tables/${r.tableId}/sync-history`, token: true },
    { method: 'GET', url: `/api/v1/tables/${r.tableId}/records/${r.recordId}/history`, token: true },
    {
      method: 'POST',
      url: `/api/v1/databases/${r.databaseId}/joined-tables`,
      token: true,
      payload: tenantTools(r).create_joined_table!.table as Record<string, unknown>,
    },
    ...['/api', '/api/v1'].map((prefix) => ({
      method: 'POST' as const,
      url: `${prefix}/databases/${r.databaseId}/column-suggestions`,
      token: prefix.includes('/v1'),
      payload: tenantTools(r).suggest_joined_columns!,
    })),
    {
      method: 'PATCH',
      url: `/api/v1/tables/${r.tableId}/joined-columns`,
      token: true,
      payload: tenantTools(r).configure_joined_columns!.joined as Record<string, unknown>,
    },
    {
      method: 'PATCH',
      url: `/api/v1/tables/${r.tableId}/overrides`,
      token: true,
      payload: { historyRetentionDays: 30 },
    },
    {
      method: 'POST',
      url: `/api/v1/tables/${r.tableId}/clear-overrides`,
      token: true,
      payload: { records: [{ id: r.recordId, fieldIds: [r.fieldId] }] },
    },
    {
      method: 'POST',
      url: `${rest}/move`,
      token: true,
      payload: { viewId: r.viewId, recordIds: [r.recordId], place: { before: newId('record') } },
    },
    { method: 'PUT', url: `${rest}/locks`, token: true, payload: { recordIds: [r.recordId], locked: true } },
    {
      method: 'PUT',
      url: rest,
      token: true,
      payload: { records: [{ id: r.recordId, fields: { [r.fieldId]: 'changed' } }] },
    },
    { method: 'GET', url: `/api/databases/${r.databaseId}/schema` },
    { method: 'GET', url: `${view}/rows` },
    { method: 'GET', url: `${view}/position?recordId=${r.recordId}` },
    { method: 'GET', url: `${view}/export?format=csv&locale=en-US&timeZone=UTC` },
    { method: 'GET', url: `${table}/records/${r.recordId}` },
    { method: 'POST', url: `/api/dashboards/${r.dashboardId}/data`, payload: { timeZone: 'UTC' } },
    {
      method: 'POST',
      url: `/api/interfaces/${r.interfaceId}/data`,
      payload: { pageId: 'page01', timeZone: 'UTC' },
    },
    { method: 'POST', url: `${view}/search`, payload: { query: 'TENANT_SENTINEL' } },
    { method: 'POST', url: `${table}/records/names`, payload: { ids: [r.recordId] } },
    {
      method: 'POST',
      url: `/api/fields/${r.fieldId}/conversion-preview`,
      payload: { to: { type: 'number' }, dateOrder: 'mdy', timeZone: 'UTC' },
    },
    { method: 'PUT', url: `/api/databases/${r.databaseId}/favorite`, payload: { favorite: true } },
    {
      method: 'POST',
      url: `/api/databases/${r.databaseId}/commands`,
      batch: true,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            kind: 'record.update',
            id: newId('command'),
            groupId: newId('action'),
            tableId: r.tableId,
            records: [{ id: r.recordId, values: { [r.fieldId]: 'changed' } }],
          },
        ],
      },
    },
    { method: 'GET', url: `/api/v1/databases/${r.databaseId}/tables`, token: true },
    { method: 'GET', url: `/api/v1/tables/${r.tableId}/views`, token: true },
    { method: 'GET', url: rest, token: true },
    { method: 'GET', url: `${rest}/${r.recordId}`, token: true },
    {
      method: 'POST',
      url: rest,
      token: true,
      payload: { records: [{ fields: { [r.fieldId]: 'changed' } }] },
    },
    {
      method: 'PATCH',
      url: rest,
      token: true,
      payload: { records: [{ id: r.recordId, fields: { [r.fieldId]: 'changed' } }] },
    },
    { method: 'DELETE', url: `${rest}?recordIds[]=${r.recordId}`, token: true },
    { method: 'GET', url: `${rest}/${r.recordId}/comments`, token: true },
    {
      method: 'POST',
      url: `${rest}/${r.recordId}/comments`,
      token: true,
      payload: { id: newId('comment'), body: 'changed', fieldId: r.fieldId },
    },
    { method: 'GET', url: `${table}/comments?recordIds=${r.recordId}` },
  ] as const;
}

export function tenantTools(r: TenantResource): Record<string, Record<string, unknown>> {
  const record = { id: r.recordId, fields: { [r.fieldId]: 'changed' } };
  const outputFieldId = newId('field');
  const definition = { name: 'CHANGED_FUNCTION', parameters: [], body: '2', description: '' };
  const joined = {
    baseTableId: r.tableId,
    steps: [
      {
        tableId: r.joinedTableId,
        leftTableId: r.tableId,
        leftFieldId: r.fieldId,
        rightFieldId: r.joinedFieldId,
        kind: 'inner',
      },
    ],
    fields: [{ tableId: r.tableId, fieldId: r.fieldId, outputFieldId }],
  };
  return {
    suggest_joined_columns: {
      databaseId: r.databaseId,
      baseTableId: joined.baseTableId,
      steps: joined.steps,
    },
    configure_joined_columns: { tableId: r.tableId, joined },
    duplicate_records: { tableId: r.tableId, recordIds: [r.recordId] },
    duplicate_field: { fieldId: r.fieldId, name: 'Field copy', withValues: true },
    duplicate_table: { tableId: r.tableId, name: 'Table copy', withRecords: true },
    get_duplicate_job: { jobId: r.jobId },
    cancel_duplicate_job: { jobId: r.jobId },
    list_named_functions: { databaseId: r.databaseId },
    create_named_function: { databaseId: r.databaseId, input: definition },
    update_named_function: {
      databaseId: r.databaseId,
      functionId: r.functionId,
      input: { definition, revision: 1 },
    },
    delete_named_function: {
      databaseId: r.databaseId,
      functionId: r.functionId,
      input: { revision: 1, confirmUsed: true },
    },
    list_databases: {},
    list_folders: {},
    list_knowledge: {},
    list_connected_tools: {},
    web_search: { query: 'Synthetic query' },
    search_knowledge: { query: 'TENANT_SENTINEL', libraryId: r.libraryId },
    change_knowledge: {
      command: {
        kind: 'library.save',
        id: randomUUID(),
        libraryId: r.libraryId,
        scope: { kind: 'database', databaseId: r.databaseId },
        details: { name: 'changed', description: '', label: 'public' },
      },
    },
    change_home: {
      id: newId('command'),
      action: {
        kind: 'shortcut.create',
        shortcutId: newId('shortcut'),
        target: { kind: 'view', id: r.viewId },
      },
    },
    create_joined_table: {
      databaseId: r.databaseId,
      table: {
        id: newId('table'),
        name: 'Joined',
        fields: [{ id: outputFieldId, name: 'Text', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        joined,
      },
    },
    preview_document_import: {
      databaseId: r.databaseId,
      tableId: r.tableId,
      data: 'YSxiCg==',
      mediaType: 'text/csv',
      label: 'public',
      locale: 'en-US',
    },
    run_button: { databaseId: r.databaseId, fieldId: r.fieldId, recordId: r.recordId },
    find_similar_records: { tableId: r.tableId, text: 'TENANT_SENTINEL' },
    list_memories: { databaseId: r.databaseId },
    remember: { databaseId: r.databaseId, memoryId: randomUUID(), text: 'changed' },
    forget: { databaseId: r.databaseId, memoryId: randomUUID() },
    get_schema: { databaseId: r.databaseId },
    get_record: { tableId: r.tableId, recordId: r.recordId },
    find_records: { tableId: r.tableId },
    count_records: { tableId: r.tableId },
    aggregate_records: { tableId: r.tableId, measures: [{ fn: 'count' }] },
    get_record_history: { tableId: r.tableId, recordId: r.recordId },
    get_sync_history: { tableId: r.tableId },
    configure_grid: { viewId: r.viewId, config: {} },
    configure_overrides: { tableId: r.tableId, historyRetentionDays: 30 },
    clear_overrides: { tableId: r.tableId, records: [{ id: r.recordId, fieldIds: [r.fieldId] }] },
    create_records: { tableId: r.tableId, records: [{ fields: record.fields }] },
    update_records: { tableId: r.tableId, records: [record] },
    create_table: {
      databaseId: r.databaseId,
      input: { name: 'Changed', fields: [{ name: 'Name', type: 'text' }] },
    },
    update_table: { tableId: r.tableId, input: { name: 'Changed' } },
    trash_table: { tableId: r.tableId },
    create_field: { tableId: r.tableId, input: { name: 'Changed', type: 'text' } },
    update_field: { fieldId: r.fieldId, input: { name: 'Changed' } },
    trash_field: { fieldId: r.fieldId },
    create_view: { tableId: r.tableId, input: { name: 'Changed' } },
    update_view: { viewId: r.viewId, input: { name: 'Changed' } },
    trash_view: { viewId: r.viewId },
    get_comments: { tableId: r.tableId, recordId: r.recordId },
    create_comment: {
      tableId: r.tableId,
      recordId: r.recordId,
      comment: { id: newId('comment'), body: 'changed', fieldId: r.fieldId },
    },
    propose_record_update: { tableId: r.tableId, records: [record] },
    delete_records: { tableId: r.tableId, recordIds: [r.recordId] },
    move_records: {
      tableId: r.tableId,
      viewId: r.viewId,
      recordIds: [r.recordId],
      place: { before: newId('record') },
    },
    set_record_locks: { tableId: r.tableId, recordIds: [r.recordId], locked: true },
    attach_file_from_url: {
      tableId: r.tableId,
      recordId: r.recordId,
      fieldId: r.attachmentFieldId,
      url: 'https://example.test/file.txt',
    },
    ...Object.fromEntries(
      (['dashboard', 'interface', 'automation'] as const).map((kind) => [
        `get_${kind}`,
        {
          databaseId: r.databaseId,
          id: r[`${kind}Id`],
        },
      ]),
    ),
  };
}
