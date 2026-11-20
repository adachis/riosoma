import type { FastifyError, FastifyInstance } from 'fastify';
import { withTransaction } from '@riosoma/db';
import { z } from 'zod';
import { authDatabase, tokenHash } from '../database.js';
import { dataStore } from '../../data/context.js';
import { serverOrigin } from '../sso/store.js';
import { ScimError, invalidFilter, invalidValue, storable } from './errors.js';
import { ENTERPRISE_SCHEMA, GROUP_SCHEMA, USER_SCHEMA, type ResourceKind } from './patch.js';
import { listResponse, project } from './resources.js';
import { changeResource, getResource, listResources, notFound, resourceView } from './store.js';
import type { TokenRow } from './admin.js';

declare module 'fastify' {
  interface FastifyRequest {
    scimToken: TokenRow | null;
  }
}

const Projection = z.object({
  attributes: z.string().max(4096).optional(),
  excludedAttributes: z.string().max(4096).optional(),
});
const Query = Projection.extend({
  filter: z.string().optional(),
  startIndex: z.coerce.number().int().default(1),
  count: z.coerce.number().int().default(100),
});
const Params = z.object({ resourceId: z.string().min(1).max(1000) });
const RATE_LIMIT = 120;
const MAX_DEPTH = 64;

/** Every string and key in a request must be storable, and nesting stays shallow, as SCIM's is. */
function storableTree(root: unknown): boolean {
  const pending: Array<[unknown, number]> = [[root, 0]];
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    if (typeof value === 'string') {
      if (!storable(value)) return false;
    } else if (value !== null && typeof value === 'object') {
      if (depth > MAX_DEPTH) return false;
      for (const [key, item] of Object.entries(value)) {
        if (!storable(key)) return false;
        pending.push([item, depth + 1]);
      }
    }
  }
  return true;
}

function projection(query: unknown) {
  const parsed = Projection.safeParse(query);
  return parsed.success ? parsed.data : invalidValue();
}
const RESOURCE_TYPE_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

function schemaAttribute(name: string, type = 'string', options: Record<string, unknown> = {}) {
  return {
    name,
    type,
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: 'none',
    ...options,
  };
}

const SCHEMAS = [
  {
    schemas: [SCHEMA_SCHEMA],
    id: USER_SCHEMA,
    name: 'User',
    attributes: [
      schemaAttribute('id', 'string', {
        mutability: 'readOnly',
        caseExact: true,
        returned: 'always',
        uniqueness: 'server',
      }),
      schemaAttribute('externalId', 'string', { caseExact: true }),
      schemaAttribute('userName', 'string', { required: true, uniqueness: 'server' }),
      schemaAttribute('displayName'),
      schemaAttribute('active', 'boolean'),
      schemaAttribute('name', 'complex', {
        subAttributes: ['givenName', 'familyName', 'formatted'].map((name) => schemaAttribute(name)),
      }),
      schemaAttribute('emails', 'complex', {
        multiValued: true,
        subAttributes: [
          schemaAttribute('value'),
          schemaAttribute('type'),
          schemaAttribute('primary', 'boolean'),
          schemaAttribute('display'),
        ],
      }),
    ],
  },
  {
    schemas: [SCHEMA_SCHEMA],
    id: GROUP_SCHEMA,
    name: 'Group',
    attributes: [
      schemaAttribute('id', 'string', {
        mutability: 'readOnly',
        caseExact: true,
        returned: 'always',
        uniqueness: 'server',
      }),
      schemaAttribute('externalId', 'string', { caseExact: true }),
      schemaAttribute('displayName', 'string', { required: true }),
      schemaAttribute('members', 'complex', {
        multiValued: true,
        subAttributes: [schemaAttribute('value', 'string', { caseExact: true }), schemaAttribute('type')],
      }),
    ],
  },
  {
    schemas: [SCHEMA_SCHEMA],
    id: ENTERPRISE_SCHEMA,
    name: 'EnterpriseUser',
    attributes: [
      schemaAttribute('department'),
      schemaAttribute('employeeNumber'),
      schemaAttribute('manager', 'complex', {
        subAttributes: [
          schemaAttribute('value', 'string', { caseExact: true }),
          schemaAttribute('displayName'),
        ],
      }),
    ],
  },
];

export async function scimRoutes(app: FastifyInstance): Promise<void> {
  app.decorateRequest('scimToken', null);
  app.addContentTypeParser(
    'application/scim+json',
    { parseAs: 'string' },
    app.getDefaultJsonParser('error', 'error'),
  );
  app.addHook('onSend', async (_request, reply) => {
    reply.type('application/scim+json');
    reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((error: FastifyError | ScimError, request, reply) => {
    const status = error instanceof ScimError ? error.status : (error.statusCode ?? 500);
    const key =
      error instanceof ScimError
        ? error.messageKey
        : status >= 500
          ? 'errors.internal'
          : 'scim.errors.invalidValue';
    if (status >= 500)
      request.log.error({ code: 'code' in error ? error.code : undefined }, 'scim request failed');
    if (status === 429) reply.header('retry-after', '60');
    if (status === 401) reply.header('www-authenticate', 'Bearer');
    return reply.code(status).send({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: String(status),
      detail: (error instanceof ScimError && error.detail) || key,
      ...(error instanceof ScimError && error.scimType
        ? { scimType: error.scimType }
        : status === 400
          ? { scimType: 'invalidValue' }
          : {}),
    });
  });
  app.addHook('onRequest', async (request) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? '');
    if (!match || !app.ctx.pool || !app.ctx.config.database)
      throw new ScimError(401, 'scim.errors.tokenInvalid');
    const { pool, app: schema } = authDatabase(app.ctx);
    const token = await withTransaction(pool, async (db) => {
      const result = await db.query<TokenRow & { allowed: boolean }>(
        `UPDATE ${schema}.scim_tokens SET
        last_used_at = clock_timestamp(),
        rate_count = CASE WHEN rate_started_at <= clock_timestamp() - interval '1 minute' THEN 1 ELSE LEAST(rate_count + 1, $2 + 1) END,
        rate_started_at = CASE WHEN rate_started_at <= clock_timestamp() - interval '1 minute' THEN clock_timestamp() ELSE rate_started_at END
        WHERE secret_hash = $1 AND revoked_at IS NULL RETURNING *, rate_count <= $2 AS allowed`,
        [tokenHash(match[1]!), RATE_LIMIT],
      );
      return result.rows[0];
    });
    if (!token) throw new ScimError(401, 'scim.errors.tokenInvalid');
    if (!token.allowed) throw new ScimError(429, 'scim.errors.rateLimit');
    request.scimToken = token;
  });
  app.addHook('preHandler', async (request) => {
    const query = request.query as Record<string, unknown> | undefined;
    const filter = query?.filter;
    // Over-long, repeated, and unstorable filters are filter errors, whatever else is wrong.
    if (filter !== undefined && (typeof filter !== 'string' || filter.length > 4096 || !storable(filter)))
      invalidFilter();
    if (!storableTree(request.params) || !storableTree(query) || !storableTree(request.body)) invalidValue();
  });

  app.get('/scim/v2/ServiceProviderConfig', async () => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 1000 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'scim.authentication.bearer',
        description: 'scim.authentication.description',
        primary: true,
      },
    ],
  }));
  const resourceTypes = [
    {
      schemas: [RESOURCE_TYPE_SCHEMA],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      schema: USER_SCHEMA,
      schemaExtensions: [{ schema: ENTERPRISE_SCHEMA, required: false }],
    },
    {
      schemas: [RESOURCE_TYPE_SCHEMA],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      schema: GROUP_SCHEMA,
      schemaExtensions: [],
    },
  ];
  app.get('/scim/v2/ResourceTypes', async () => listResponse(resourceTypes));
  const requestedId = (request: { params: unknown }) => {
    const params = Params.safeParse(request.params);
    return params.success ? params.data.resourceId : notFound();
  };
  app.get('/scim/v2/ResourceTypes/:resourceId', async (request) => {
    const id = requestedId(request);
    return resourceTypes.find((type) => type.id === id) ?? notFound();
  });
  app.get('/scim/v2/Schemas', async () => listResponse(SCHEMAS));
  app.get('/scim/v2/Schemas/:resourceId', async (request) => {
    const id = requestedId(request);
    return SCHEMAS.find((schema) => schema.id === id) ?? notFound();
  });
  for (const kind of ['Users', 'Groups'] as const satisfies readonly ResourceKind[]) {
    app.get(`/scim/v2/${kind}`, async (request) => {
      const input = Query.safeParse(request.query);
      if (!input.success) invalidValue();
      const { attributes, excludedAttributes } = input.data;
      const list = await listResources(
        app.ctx,
        request.scimToken!,
        kind,
        `${serverOrigin(app.ctx, request)}/scim/v2`,
        input.data.filter,
        Math.max(1, input.data.startIndex),
        Math.max(0, Math.min(1000, input.data.count)),
      );
      return {
        ...list,
        Resources: list.Resources.map((resource) =>
          project(resource as Record<string, unknown>, kind, attributes, excludedAttributes),
        ),
      };
    });
    app.get(`/scim/v2/${kind}/:resourceId`, async (request) => {
      const params = Params.safeParse(request.params);
      if (!params.success) notFound();
      const { attributes, excludedAttributes } = projection(request.query);
      const { pool, schemas } = dataStore(app.ctx);
      const view = resourceView(
        await getResource(pool, schemas.app, request.scimToken!.org_id, kind, params.data.resourceId),
        kind,
        `${serverOrigin(app.ctx, request)}/scim/v2`,
      );
      return project(view, kind, attributes, excludedAttributes);
    });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      app.route({
        method,
        url: `/scim/v2/${kind}${method === 'POST' ? '' : '/:resourceId'}`,
        bodyLimit: 1024 * 1024,
        handler: async (request, reply) => {
          const params = method === 'POST' ? undefined : Params.safeParse(request.params);
          if (params && !params.success) notFound();
          const { attributes, excludedAttributes } = projection(request.query);
          const result = await changeResource(
            app.ctx,
            request.scimToken!,
            kind,
            method,
            params?.data?.resourceId,
            request.body,
          );
          if (result.dryRun) reply.header('x-scim-dry-run', 'true');
          if (method === 'DELETE') return reply.code(204).send();
          const view = resourceView(result.row!, kind, `${serverOrigin(app.ctx, request)}/scim/v2`);
          reply.header('location', view.meta.location);
          return reply
            .code(method === 'POST' ? 201 : 200)
            .send(project(view, kind, attributes, excludedAttributes));
        },
      });
    }
  }
  app.all('/scim/v2/*', async () => notFound());
}
