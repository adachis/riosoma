import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Swagger has fewer schema forms, so unions retain their JSON contract as an extension. */
export function swagger(source) {
  const definitions = {};
  const pointer = (ref) =>
    ref
      .slice(2)
      .split('/')
      .reduce((value, key) => value[key.replaceAll('~1', '/').replaceAll('~0', '~')], source);
  const reference = (ref) => {
    if (ref === '#/components/schemas/Records') ref = '#/components/schemas/AirtableRecords';
    const name = ref.slice('#/components/schemas/'.length).replaceAll('/', '_').replaceAll('$', '');
    if (!(name in definitions)) {
      definitions[name] = {};
      definitions[name] = schema(pointer(ref));
    }
    return { $ref: `#/definitions/${name}` };
  };
  const schema = (input) => {
    if (!input || typeof input !== 'object') return {};
    if (input.$ref) return reference(input.$ref);
    const result = {};
    for (const [key, value] of Object.entries(input)) {
      if (
        [
          'title',
          'description',
          'format',
          'default',
          'enum',
          'required',
          'minLength',
          'maxLength',
          'pattern',
          'minimum',
          'maximum',
          'minItems',
          'maxItems',
          'uniqueItems',
          'minProperties',
          'maxProperties',
        ].includes(key)
      )
        result[key] = value;
      else if (key === 'type') {
        const types = (Array.isArray(value) ? value : [value]).filter((type) => type !== 'null');
        if (types.length === 1) result.type = types[0];
        if (types.length !== (Array.isArray(value) ? value.length : 1)) result['x-nullable'] = true;
      } else if (key === 'const') result.enum = [value];
      else if (key === 'properties')
        result.properties = Object.fromEntries(
          Object.entries(value).map(([name, child]) => [name, schema(child)]),
        );
      else if (key === 'items') result.items = schema(value);
      else if (key === 'additionalProperties')
        result.additionalProperties = typeof value === 'boolean' ? value : schema(value);
      else if (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') {
        result[key.slice(9).toLowerCase()] = value;
        result[key] = true;
      } else if (key === 'anyOf' || key === 'oneOf') {
        const variants = value.filter((variant) => variant.type !== 'null');
        if (variants.length === 1) Object.assign(result, schema(variants[0]));
        else {
          const types = new Set(variants.map((variant) => variant.type));
          if (types.size === 1 && !types.has(undefined)) result.type = variants[0].type;
          if (result.type === 'array') result.items = {};
          result['x-riosoma-union'] = value.map(schema);
        }
        if (variants.length !== value.length) result['x-nullable'] = true;
      }
    }
    return result;
  };
  const parameter = (input) => {
    const { name, required, description } = input;
    const common = { name, in: input.in, required, ...(description ? { description } : {}) };
    if (input.content) return { ...common, type: 'string', 'x-ms-visibility': 'advanced' };
    const original = input.schema.$ref ? pointer(input.schema.$ref) : input.schema;
    const converted = schema(original);
    if (name === 'shape')
      return {
        ...common,
        type: 'string',
        enum: ['airtable'],
        default: 'airtable',
        required: true,
        'x-ms-visibility': 'internal',
      };
    return {
      ...common,
      ...converted,
      ...(converted.type === 'array' ? { collectionFormat: 'multi' } : {}),
      ...(input.in === 'query' ? { 'x-ms-visibility': 'advanced' } : {}),
    };
  };
  const paths = {};
  for (const [path, methods] of Object.entries(source.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation.operationId) continue;
      const parameters = operation.parameters.map(parameter);
      if (operation.requestBody)
        parameters.push({
          name: 'body',
          in: 'body',
          required: true,
          schema: schema(operation.requestBody.content['application/json'].schema),
        });
      const responses = Object.fromEntries(
        Object.entries(operation.responses).map(([status, response]) => [
          status,
          {
            description: response.description,
            ...(response.content ? { schema: schema(response.content['application/json'].schema) } : {}),
            ...(response.headers
              ? {
                  headers: Object.fromEntries(
                    Object.entries(response.headers).map(([name, header]) => [
                      name,
                      { description: header.description, ...schema(header.schema) },
                    ]),
                  ),
                }
              : {}),
          },
        ]),
      );
      (paths[path] ??= {})[method] = {
        operationId: operation.operationId,
        summary: operation.summary,
        description: operation.description,
        'x-ms-visibility': operation['x-ms-visibility'],
        security: [{ oauth2: [operation['x-required-scope']] }],
        parameters,
        responses,
      };
    }
  }
  return {
    swagger: '2.0',
    info: source.info,
    basePath: '/',
    schemes: ['https'],
    consumes: ['application/json'],
    produces: ['application/json'],
    paths,
    definitions,
    securityDefinitions: {
      oauth2: {
        type: 'oauth2',
        flow: 'accessCode',
        authorizationUrl: 'https://example.invalid/oauth/authorize',
        tokenUrl: 'https://example.invalid/oauth/token',
        scopes: {
          'schema.bases:read': source.paths['/api/v1/databases'].get.summary,
          'schema.bases:write': source.paths['/api/v1/databases/{databaseId}/named-functions'].post.summary,
          'data.records:read': source.paths['/api/v1/tables/{tableId}/records'].get.summary,
          'data.records:write': source.paths['/api/v1/tables/{tableId}/records'].patch.summary,
        },
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv.includes('--stdin')
    ? JSON.parse(await Array.fromAsync(process.stdin).then((chunks) => chunks.join('')))
    : (await import('../apps/server/dist/api-v1/openapi.js')).openapi();
  const output = `${JSON.stringify(swagger(input), null, 2)}\n`;
  if (process.argv.includes('--stdin')) process.stdout.write(output);
  else {
    await writeFile(
      new URL('../integrations/power-platform/riosoma-api/apiDefinition.swagger.json', import.meta.url),
      output,
    );
    const { mcpConnector } = await import('../apps/server/dist/api-v1/openapi.js');
    await writeFile(
      new URL('../integrations/power-platform/riosoma-mcp/apiDefinition.swagger.json', import.meta.url),
      `${JSON.stringify(mcpConnector(), null, 2)}\n`,
    );
  }
}
