import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { mcpConnector, openapi } from './openapi.js';

const root = new URL('../../../../', import.meta.url);
const document = JSON.parse(
  readFileSync(new URL('integrations/power-platform/riosoma-api/apiDefinition.swagger.json', root), 'utf8'),
);

// This schema covers the emitted Swagger subset and rejects unsupported OpenAPI and JSON Schema keywords.
const Schema: z.ZodType = z.lazy(() =>
  z
    .object({
      $ref: z
        .string()
        .regex(/^#\/definitions\/[^/]+$/)
        .optional(),
      type: z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      format: z.string().optional(),
      enum: z.array(z.unknown()).optional(),
      default: z.unknown().optional(),
      required: z.array(z.string()).optional(),
      properties: z.record(z.string(), Schema).optional(),
      items: Schema.optional(),
      additionalProperties: z.union([z.boolean(), Schema]).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      exclusiveMinimum: z.boolean().optional(),
      exclusiveMaximum: z.boolean().optional(),
      minLength: z.number().optional(),
      maxLength: z.number().optional(),
      pattern: z.string().optional(),
      minItems: z.number().optional(),
      maxItems: z.number().optional(),
      uniqueItems: z.boolean().optional(),
      minProperties: z.number().optional(),
      maxProperties: z.number().optional(),
      'x-nullable': z.boolean().optional(),
      'x-riosoma-union': z.array(Schema).optional(),
    })
    .strict()
    .superRefine((schema, context) => {
      if (schema.type === 'array' && !schema.items)
        context.addIssue({ code: 'custom', message: 'Array items are required' });
    }),
);

it('generates Swagger 2.0 that stays synchronized with the REST contract', () => {
  const generated = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('tools/power_platform.mjs', root)), '--stdin'],
    { input: JSON.stringify(openapi()), encoding: 'utf8', maxBuffer: 5_000_000 },
  );
  expect(JSON.parse(generated)).toEqual(document);
  expect(document.swagger).toBe('2.0');
  expect(document.openapi).toBeUndefined();
  expect(document.schemes).toEqual(['https']);
  expect(document.components).toBeUndefined();
  const ids: string[] = [];
  const scopes = document.securityDefinitions.oauth2.scopes;
  expect(document.securityDefinitions.oauth2.flow).toBe('accessCode');
  for (const address of ['authorizationUrl', 'tokenUrl'])
    expect(new URL(document.securityDefinitions.oauth2[address]).protocol).toBe('https:');
  for (const schema of Object.values(document.definitions)) Schema.parse(schema);
  for (const [path, methods] of Object.entries(document.paths)) {
    expect(path.startsWith('/api/v1/')).toBe(true);
    for (const operation of Object.values(
      methods as Record<string, (typeof document.paths)[string]['get']>,
    )) {
      ids.push(operation.operationId);
      expect(operation.summary.length).toBeGreaterThan(0);
      expect(operation.description.length).toBeGreaterThan(0);
      expect(['important', 'advanced', 'internal']).toContain(operation['x-ms-visibility']);
      for (const scope of operation.security[0].oauth2) expect(scopes).toHaveProperty(scope);
      expect(operation.requestBody).toBeUndefined();
      const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      expect(
        operation.parameters
          .filter((p: { in: string }) => p.in === 'path')
          .map((p: { name: string }) => p.name)
          .sort(),
      ).toEqual(pathNames.sort());
      for (const parameter of operation.parameters) {
        expect(parameter.content).toBeUndefined();
        if (parameter.in === 'body') Schema.parse(parameter.schema);
        else {
          expect(parameter.schema).toBeUndefined();
          expect(['string', 'number', 'integer', 'boolean', 'array']).toContain(parameter.type);
          if (parameter.type === 'array') {
            expect(parameter.collectionFormat).toBe('multi');
            Schema.parse(parameter.items);
          }
          if (parameter.in === 'path') expect(parameter.required).toBe(true);
        }
      }
      for (const response of Object.values(operation.responses) as Array<{
        description: string;
        schema?: unknown;
        content?: unknown;
      }>) {
        expect(response.description).toBeTruthy();
        expect(response.content).toBeUndefined();
        if (response.schema) Schema.parse(response.schema);
      }
    }
  }
  expect(ids.sort()).toEqual(
    [
      'suggestJoinedColumns',
      'configureJoinedColumns',
      'listDatabases',
      'duplicateRecords',
      'duplicateField',
      'duplicateTable',
      'getDuplicateJob',
      'cancelDuplicateJob',
      'listNamedFunctions',
      'createNamedFunction',
      'updateNamedFunction',
      'deleteNamedFunction',
      'listTables',
      'findRecords',
      'getRecord',
      'getComments',
      'createComment',
      'createRecords',
      'updateRecords',
      'deleteRecords',
      'listViews',
      'previewDocumentImport',
    ].sort(),
  );
  expect(new Set(ids).size).toBe(ids.length);
  const references = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if ('$ref' in node)
      expect(document.definitions[String(node.$ref).replace('#/definitions/', '')]).toBeDefined();
    Object.values(node).forEach(references);
  };
  references(document);
  const preview = document.paths['/api/v1/imports/document'].post;
  expect(preview.responses['200'].schema).toEqual({ $ref: '#/definitions/DocumentImportResult' });
  expect(preview.responses['200'].headers).toBeUndefined();
  const records = document.paths['/api/v1/tables/{tableId}/records'].get;
  expect(records.parameters.find((p: { name: string }) => p.name === 'filter')).toMatchObject({
    type: 'string',
  });
  expect(records.parameters.find((p: { name: string }) => p.name === 'shape')).toMatchObject({
    enum: ['airtable'],
    default: 'airtable',
    'x-ms-visibility': 'internal',
  });
  expect(records.responses['200'].schema).toEqual({ $ref: '#/definitions/AirtableRecords' });
});

it('packages the MCP protocol marker, per-connector OAuth, and gateway selection', () => {
  for (const name of ['riosoma-api', 'riosoma-mcp']) {
    const properties = JSON.parse(
      readFileSync(new URL(`integrations/power-platform/${name}/apiProperties.json`, root), 'utf8'),
    ).properties;
    const oauth = properties.connectionParameters.token.oAuthSettings;
    expect(oauth.identityProvider).toBe('oauth2pkce');
    expect(oauth.redirectMode).toBe('GlobalPerConnector');
    expect(oauth.clientSecret).toBeUndefined();
    expect(new URL(oauth.customParameters.authorizationUrl.value).searchParams.get('resource')).toBe(
      `https://example.invalid/${name === 'riosoma-api' ? 'api/v1' : 'mcp'}`,
    );
    expect(properties.connectionParameters.gateway.type).toBe('gatewaySetting');
  }
  const wrapper = JSON.parse(
    readFileSync(new URL('integrations/power-platform/riosoma-mcp/apiDefinition.swagger.json', root), 'utf8'),
  );
  expect(wrapper).toEqual(mcpConnector());
  expect(wrapper.paths['/mcp'].post['x-ms-agentic-protocol']).toBe('mcp-streamable-1.0');
});

it('requests schema writes in the MCP connector and its OAuth template', () => {
  const connector = mcpConnector();
  expect(connector.paths['/mcp'].post.security[0]!.oauth2).toContain('schema.bases:write');
  expect(connector.securityDefinitions.oauth2.scopes).toHaveProperty('schema.bases:write');
  const template = JSON.parse(
    readFileSync(new URL('integrations/power-platform/riosoma-mcp/apiProperties.json', root), 'utf8'),
  );
  const scopes = template.properties.connectionParameters.token.oAuthSettings.scopes.join(' ').split(' ');
  expect(scopes).toContain('schema.bases:write');
  expect(scopes.sort()).toEqual(Object.keys(connector.securityDefinitions.oauth2.scopes).sort());
});

it('requests every emitted REST scope in its OAuth template', () => {
  const template = JSON.parse(
    readFileSync(new URL('integrations/power-platform/riosoma-api/apiProperties.json', root), 'utf8'),
  );
  const scopes = template.properties.connectionParameters.token.oAuthSettings.scopes.join(' ').split(' ');
  expect(scopes).toContain('schema.bases:write');
  expect(scopes.sort()).toEqual(Object.keys(document.securityDefinitions.oauth2.scopes).sort());
});
